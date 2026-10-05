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
})
