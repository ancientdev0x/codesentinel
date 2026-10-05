import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { extractAst } from '../../src/graph/nodes/extract-ast'
import { failureAnalysis } from '../../src/graph/nodes/failure-analysis'
import { humanReview } from '../../src/graph/nodes/human-review'
import { ingest } from '../../src/graph/nodes/ingest'
import { llmTriage } from '../../src/graph/nodes/llm-triage'
import { report } from '../../src/graph/nodes/report'
import { staticAnalysis } from '../../src/graph/nodes/static-analysis'
import { validate } from '../../src/graph/nodes/validate'
import type { ReviewStateType } from '../../src/graph/state'
import { resolveReviewConfig } from '../../src/review/config'
import type { Finding } from '../../src/review/findings'
import { recordRejectedPatch } from '../../src/review/patch-commands'
import { PatchError } from '../../src/review/patch'

describe('ReviewGraph nodes (E4.2)', () => {
  const baseCfg = resolveReviewConfig({ platform: 'local', workspace: process.cwd() }, {})

  const baseState: ReviewStateType = {
    cfg: baseCfg,
    files: [
      {
        fileName: 'src/main.ts',
        fileContent: 'export const hello = "world"\n',
        diff: '@@ -1,1 +1,1 @@\n+export const hello = "world"',
        changedLines: [{ start: 1, end: 1 }],
      },
    ],
    fragments: [],
    staticFindings: [],
    llmFindings: [],
    summary: 'Looks good',
    attempts: {},
    errors: [],
    degraded: [],
    recovery: null,
    approvals: {},
    handledErrorCount: 0,
  }

  it('ingest node loads changed files and records attempt', async () => {
    const fakeGetChangedFiles = vi.fn().mockResolvedValue({
      files: [{ fileName: 'a.ts', fileContent: '', diff: '', changedLines: [] }],
    })
    const node = ingest({ getChangedFiles: fakeGetChangedFiles as any })

    const update = await node(baseState)
    expect(update.files).toHaveLength(1)
    expect(update.attempts?.ingest).toBe(1)
  })

  it('extract_ast node extracts fragments and runs ast checks', async () => {
    const fakeExtract = vi.fn().mockReturnValue([{ file: 'src/main.ts' }])
    const fakeAstChecks = vi.fn().mockReturnValue([])
    const node = extractAst({
      extractAllFragments: fakeExtract as any,
      runAstChecks: fakeAstChecks as any,
    })

    const update = await node({
      ...baseState,
      cfg: { ...baseCfg, astChecks: true },
    })

    expect(fakeExtract).toHaveBeenCalled()
    expect(update.fragments).toHaveLength(1)
    expect(update.attempts?.extract_ast).toBe(1)
  })

  it('static_analysis node converts timeout into StageError', async () => {
    const fakeStaticAnalysis = vi.fn().mockResolvedValue({
      findings: [],
      runs: [{ status: 'timeout', tool: 'bandit', timeoutMs: 5000 }],
      reports: [],
    })
    const node = staticAnalysis({
      runStaticAnalysis: fakeStaticAnalysis as any,
    })

    const update = await node({
      ...baseState,
      cfg: { ...baseCfg, staticAnalysis: true },
    })

    expect(update.errors).toHaveLength(1)
    expect(update.errors?.[0].kind).toBe('timeout')
    expect(update.errors?.[0].tool).toBe('bandit')
  })

  it('validate node catches out_of_diff findings and un-triaged findings', async () => {
    const node = validate()

    const outOfDiffFinding: Finding = {
      id: 'f-out',
      source: 'llm',
      ruleId: 'sql-injection',
      severity: 'high',
      file: 'src/main.ts',
      startLine: 99,
      endLine: 100,
      message: 'SQL Injection on line 99',
      status: 'confirmed',
    }

    const unTriagedStatic: Finding = {
      id: 'f-static',
      source: 'bandit',
      ruleId: 'B602',
      severity: 'high',
      file: 'src/main.ts',
      startLine: 1,
      endLine: 1,
      message: 'Command injection',
      status: 'candidate',
    }

    const update = await node({
      ...baseState,
      llmFindings: [outOfDiffFinding],
      staticFindings: [unTriagedStatic],
    })

    expect(update.errors).toBeDefined()
    expect(update.errors?.some((e) => e.kind === 'out_of_diff')).toBe(true)
    expect(update.errors?.some((e) => e.kind === 'invalid_output')).toBe(true)
  })

  it('validate node keeps finding and strips fix when buildPatch fails with invalid_syntax', async () => {
    const node = validate({
      buildPatch: async () => {
        throw new PatchError('Invalid syntax introduced', 'invalid_syntax')
      },
    })

    const findingWithBadFix: Finding = {
      id: 'f-syntax',
      source: 'llm',
      ruleId: 'sql-injection',
      severity: 'high',
      file: 'src/main.ts',
      startLine: 1,
      endLine: 1,
      message: 'SQL Injection on line 1',
      status: 'confirmed',
      fix: {
        replacement: 'const x = ;',
        startLine: 1,
        endLine: 1,
      },
    }

    const update = await node({
      ...baseState,
      cfg: baseCfg,
      llmFindings: [findingWithBadFix],
      staticFindings: [],
    })

    // Finding kept in llmFindings, but fix stripped, and no bad_patch error logged
    expect(update.llmFindings).toHaveLength(1)
    expect(update.llmFindings?.[0].id).toBe('f-syntax')
    expect(update.llmFindings?.[0].fix).toBeUndefined()
    expect(update.errors?.some((e) => e.kind === 'bad_patch')).toBe(false)
  })

  it('human_review is a pass-through node incrementing attempts', async () => {
    const node = humanReview()
    const update = await node(baseState)
    expect(update.attempts?.human_review).toBe(1)
  })

  it('report node posts comments and summary', async () => {
    const postReviewComment = vi.fn().mockResolvedValue('url')
    const postSummary = vi.fn().mockResolvedValue('url')
    const node = report({
      createReporter: () => ({ postReviewComment, postSummary }) as any,
    })

    const update = await node({
      ...baseState,
      llmFindings: [
        {
          id: 'f1',
          source: 'llm',
          ruleId: 'r1',
          severity: 'medium',
          file: 'src/main.ts',
          startLine: 1,
          endLine: 1,
          message: 'Minor issue',
          status: 'confirmed',
        },
      ],
    })

    expect(postReviewComment).toHaveBeenCalled()
    expect(postSummary).toHaveBeenCalled()
    expect(update.attempts?.report).toBe(1)
  })

  it('report node groups multiple findings on the same line into one comment', async () => {
    const postReviewComment = vi.fn().mockResolvedValue('url')
    const postSummary = vi.fn().mockResolvedValue('url')
    const node = report({
      createReporter: () => ({ postReviewComment, postSummary }) as any,
    })

    await node({
      ...baseState,
      staticFindings: [
        {
          id: 'f-bandit',
          source: 'bandit',
          ruleId: 'B501',
          severity: 'high',
          file: 'calc.py',
          startLine: 2,
          endLine: 2,
          message: 'Insecure eval sink',
          status: 'confirmed',
        },
        {
          id: 'f-ruff',
          source: 'ruff',
          ruleId: 'S501',
          severity: 'high',
          file: 'calc.py',
          startLine: 2,
          endLine: 2,
          message: 'Possible code execution via eval',
          status: 'confirmed',
        },
      ],
      llmFindings: [
        {
          id: 'f-llm',
          source: 'llm',
          ruleId: 'py-eval',
          severity: 'critical',
          file: 'calc.py',
          startLine: 2,
          endLine: 2,
          message: 'Dynamic eval execution allows arbitrary code',
          status: 'confirmed',
          fix: {
            replacement: '    return ast.literal_eval(expr)',
            startLine: 2,
            endLine: 2,
          },
        },
      ],
    })

    // Exactly 1 comment posted for calc.py:2
    expect(postReviewComment).toHaveBeenCalledTimes(1)
    const callArg = postReviewComment.mock.calls[0][0]
    expect(callArg.filePath).toBe('calc.py')
    expect(callArg.startLine).toBe(2)

    // Leads with LLM message
    expect(callArg.comment).toContain('Dynamic eval execution allows arbitrary code')
    // Lists detectors that found it
    expect(callArg.comment).toContain(
      'Detected by: bandit B501, ruff S501 · LLM confirmed'
    )
    // Includes suggestion block exactly once
    const suggestionMatches = callArg.comment.match(/```suggestion/g)
    expect(suggestionMatches).toHaveLength(1)
  })

  it('report node populates Confirmed and Dismissed counts in analyzerReports', async () => {
    const postReviewComment = vi.fn().mockResolvedValue('url')
    const postSummary = vi.fn().mockResolvedValue('url')
    const node = report({
      createReporter: () => ({ postReviewComment, postSummary }) as any,
    })

    await node({
      ...baseState,
      analyzerReports: [
        {
          tool: 'bandit',
          backend: 'docker',
          status: 'ok',
          findings: 3,
          durationMs: 1200,
        },
        {
          tool: 'ruff',
          backend: 'docker',
          status: 'ok',
          findings: 1,
          durationMs: 400,
        },
      ],
      staticFindings: [
        {
          id: 'b1',
          source: 'bandit',
          ruleId: 'B602',
          severity: 'high',
          file: 'src/main.ts',
          startLine: 1,
          endLine: 1,
          message: 'issue 1',
          status: 'confirmed',
        },
        {
          id: 'b2',
          source: 'bandit',
          ruleId: 'B603',
          severity: 'high',
          file: 'src/main.ts',
          startLine: 2,
          endLine: 2,
          message: 'issue 2',
          status: 'confirmed',
        },
        {
          id: 'b3',
          source: 'bandit',
          ruleId: 'B604',
          severity: 'low',
          file: 'src/main.ts',
          startLine: 3,
          endLine: 3,
          message: 'issue 3',
          status: 'dismissed',
        },
        {
          id: 'r1',
          source: 'ruff',
          ruleId: 'S101',
          severity: 'medium',
          file: 'src/main.ts',
          startLine: 4,
          endLine: 4,
          message: 'issue 4',
          status: 'confirmed',
        },
      ],
      llmFindings: [],
    })

    expect(postSummary).toHaveBeenCalled()
    const summaryRows = postSummary.mock.calls[0][1]
    expect(summaryRows).toBeDefined()
    expect(summaryRows).toHaveLength(2)

    const banditRow = summaryRows.find((r: any) => r.tool === 'bandit')
    expect(banditRow.confirmed).toBe(2)
    expect(banditRow.dismissed).toBe(1)

    const ruffRow = summaryRows.find((r: any) => r.tool === 'ruff')
    expect(ruffRow.confirmed).toBe(1)
    expect(ruffRow.dismissed).toBe(0)
  })

  it('report node skips findings whose id was rejected', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'report-reject-test-'))
    try {
      await recordRejectedPatch(tmpDir, 'p1234567', 'user1', 'f-rejected')

      const postReviewComment = vi.fn().mockResolvedValue('url')
      const postSummary = vi.fn().mockResolvedValue('url')
      const node = report({
        createReporter: () => ({ postReviewComment, postSummary }) as any,
      })

      await node({
        ...baseState,
        cfg: { ...baseCfg, workspace: tmpDir },
        staticFindings: [
          {
            id: 'f-rejected',
            source: 'bandit',
            ruleId: 'B602',
            severity: 'high',
            file: 'src/main.ts',
            startLine: 1,
            endLine: 1,
            message: 'Insecure call',
            status: 'confirmed',
          },
          {
            id: 'f-allowed',
            source: 'bandit',
            ruleId: 'B603',
            severity: 'high',
            file: 'src/main.ts',
            startLine: 1,
            endLine: 1,
            message: 'Allowed call',
            status: 'confirmed',
          },
        ],
        llmFindings: [],
      })

      expect(postReviewComment).toHaveBeenCalledTimes(1)
      expect(postReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: expect.stringContaining('Allowed call'),
        })
      )
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('report node formats deterministic findings table and skips "see the inline comments" when llm_triage is degraded', async () => {
    let capturedSummary = ''
    const postReviewComment = vi.fn().mockResolvedValue('url')
    const postSummary = vi.fn().mockImplementation(async (text: string) => {
      capturedSummary = text
      return 'https://github.com/owner/repo/pull/1#issuecomment-1'
    })
    const node = report({
      createReporter: () => ({ postReviewComment, postSummary }) as any,
    })

    const update = await node({
      ...baseState,
      degraded: ['llm_triage'],
      summary: '',
      staticFindings: [
        {
          id: 'f-cand-1',
          source: 'bandit',
          ruleId: 'B602',
          severity: 'high',
          file: 'app/run.py',
          startLine: 5,
          endLine: 5,
          message: 'subprocess call with shell=True',
          status: 'candidate',
        },
        {
          id: 'f-cand-2',
          source: 'bandit',
          ruleId: 'B608',
          severity: 'critical',
          file: 'app/db.py',
          startLine: 12,
          endLine: 12,
          message: 'SQL injection formatted query',
          status: 'candidate',
        },
      ],
      llmFindings: [],
    })

    expect(capturedSummary).not.toContain('see the inline comments')
    expect(capturedSummary).toContain(
      'LLM triage unavailable — showing deterministic analyzer findings only.'
    )
    expect(capturedSummary).toContain('| File:Line | Rule | Severity | Message |')
    expect(capturedSummary).toContain(
      '| app/db.py:12 | B608 | CRITICAL | SQL injection formatted query |'
    )
    expect(capturedSummary).toContain(
      '| app/run.py:5 | B602 | HIGH | subprocess call with shell=True |'
    )
    expect(capturedSummary).toContain('> ⚠️ **Degraded components / tools**: llm_triage')

    // Candidate findings are also posted as inline comments
    expect(postReviewComment).toHaveBeenCalledTimes(2)
    expect(update.summary).toBe(capturedSummary)
  })

  it('llm_triage prompts active session and captures summary', async () => {
    const fakeSession = {
      prompt: vi.fn().mockResolvedValue({ text: 'Detailed review summary.' }),
    }
    const node = llmTriage({
      session: fakeSession,
      tracedPrompt: vi.fn().mockResolvedValue({ text: 'Detailed review summary.' }),
    })

    const update = await node(baseState)
    expect(update.summary).toBe('Detailed review summary.')
    expect(update.attempts?.llm_triage).toBe(1)
  })

  it('failure_analysis routes timeout error to static_analysis retry', async () => {
    const errorState: ReviewStateType = {
      ...baseState,
      attempts: { static_analysis: 1 },
      errors: [
        {
          stage: 'static_analysis',
          kind: 'timeout',
          tool: 'bandit',
          detail: 'Timeout',
        },
      ],
      handledErrorCount: 0,
    }

    const update = await failureAnalysis(errorState)
    expect(update.recovery?.retry).toBe('static_analysis')
    expect(update.recovery?.adjust?.timeoutMs).toBeGreaterThan(0)
    expect(update.handledErrorCount).toBe(1)
  })

  it('validate node normalizes finding paths from absolute to repo-relative', async () => {
    const tmpWs = '/tmp/codesentinel-pr-test'
    const validateNode = validate()
    const update = await validateNode({
      ...baseState,
      cfg: { ...baseCfg, workspace: tmpWs },
      files: [
        {
          fileName: `${tmpWs}/app/calc.py`,
          fileContent: 'def eval_code(x):\n  return eval(x)\n',
          diff: '@@ -1,2 +1,2 @@\n+def eval_code(x):\n+  return eval(x)',
          changedLines: [{ start: 1, end: 2 }],
        },
      ],
      llmFindings: [
        {
          id: 'test-llm-1',
          source: 'llm',
          ruleId: 'CWE-95',
          severity: 'high',
          file: `${tmpWs}/app/calc.py`,
          startLine: 2,
          endLine: 2,
          message: 'eval used',
          status: 'confirmed',
        },
      ],
      staticFindings: [
        {
          id: 'test-static-1',
          source: 'ast-grep',
          ruleId: 'py-eval-exec',
          severity: 'high',
          file: `${tmpWs}/app/calc.py`,
          startLine: 2,
          endLine: 2,
          message: 'eval used',
          status: 'confirmed',
        },
      ],
      summary: 'Found eval vulnerability',
    })

    expect(update.errors).toHaveLength(0)
    expect(update.llmFindings?.[0].file).toBe('app/calc.py')
    expect(update.staticFindings?.[0].file).toBe('app/calc.py')
  })

  it('report node posts review comments using repo-relative paths', async () => {
    const tmpWs = '/tmp/codesentinel-pr-test'
    const postReviewComment = vi.fn().mockResolvedValue('url')
    const postSummary = vi.fn().mockResolvedValue('url')
    const reportNode = report({
      createReporter: () => ({ postReviewComment, postSummary }) as any,
    })

    await reportNode({
      ...baseState,
      cfg: { ...baseCfg, workspace: tmpWs },
      llmFindings: [
        {
          id: 'test-llm-1',
          source: 'llm',
          ruleId: 'CWE-95',
          severity: 'high',
          file: `${tmpWs}/app/calc.py`,
          startLine: 2,
          endLine: 2,
          message: 'eval used',
          status: 'confirmed',
        },
      ],
      staticFindings: [],
      summary: 'Summary text',
    })

    expect(postReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: 'app/calc.py',
      })
    )
  })
})
