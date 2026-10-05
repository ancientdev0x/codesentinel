import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrCreateCollector } from '../../src/graph/collector'

// Mock only the collaborators that touch git or GitHub. `filterFiles` and
// `resolveReviewConfig` are exercised for real (the latter reads process.env).
const getChangedFiles = vi.fn()
vi.mock('../../src/review/diff', async (orig) => ({
  ...(await orig<typeof import('../../src/review/diff')>()),
  getChangedFiles: (...args: unknown[]) => getChangedFiles(...args),
}))

const postSummary = vi.fn().mockResolvedValue('http://s')
const postReviewComment = vi.fn().mockResolvedValue('http://c')
const createReporter = vi.fn(() => ({ postSummary, postReviewComment }))
vi.mock('../../src/github/reporter', () => ({
  createReporter: (...args: unknown[]) => createReporter(...args),
}))

const cleanupPr = vi.fn().mockResolvedValue(undefined)
const materializePr = vi.fn().mockResolvedValue({
  workspace: '/tmp/pr-worktree',
  baseSha: 'base-sha-123',
  headSha: 'head-sha-456',
  ref: { host: 'github.com', owner: 'owner', repo: 'repo', number: 42 },
  cleanup: cleanupPr,
})
vi.mock('../../src/review/source', async (orig) => {
  const actual = await orig<typeof import('../../src/review/source')>()
  return {
    ...actual,
    materializePr: (...args: unknown[]) => materializePr(...args),
  }
})

const runStaticAnalysis = vi
  .fn()
  .mockResolvedValue({ findings: [], runs: [], reports: [] })
vi.mock('../../src/review/analyzers', () => ({
  runStaticAnalysis: (...args: unknown[]) => runStaticAnalysis(...args),
}))

import reviewWorkflow from '../../src/workflows/review'

// flue beta.9: the workflow is defineWorkflow({ agent, run }). Its run handler lives
// on `.action.run(context)` and receives { harness, log, input }. Config resolves from
// process.env (the agent self-configures the same way + self-connects any MCP tools),
// so the workflow no longer takes a payload or manages MCP lifecycle.
const makeHarness = (text: unknown = 'SUMMARY') => {
  const session = { prompt: vi.fn().mockResolvedValue({ text }) }
  const harness = { session: vi.fn().mockResolvedValue(session) }
  return { harness, session }
}

const runWorkflow = (harness: unknown, input: unknown = {}) =>
  reviewWorkflow.action.run({ harness, log: {}, input } as never)

const makeFile = (fileName: string) => ({
  fileName,
  fileContent: 'export const a = 1\n',
  changedLines: [{ start: 1, end: 1 }],
  diff: `diff --git a/${fileName} b/${fileName}\n@@ -0,0 +1 @@\n+export const a = 1`,
})

describe('review workflow run()', () => {
  beforeEach(() => {
    // Telemetry uses a real fetch; keep it offline and deterministic.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    delete process.env.CodeSentinel_PR_URL
    delete process.env.CODESENTINEL_PR_URL
    delete process.env.CodeSentinel_INPUT_PLATFORM
  })

  it('returns early without driving the agent when no files changed', async () => {
    getChangedFiles.mockResolvedValue({ files: [], rawDiff: '' })
    const { harness } = makeHarness()

    const result = await runWorkflow(harness)

    expect(result).toEqual({
      reviewed: 0,
      summaryPosted: false,
      message: 'No changed files to review.',
    })
    expect(harness.session).not.toHaveBeenCalled()
    expect(createReporter).not.toHaveBeenCalled()
  })

  it('drives the agent over the harness and posts the summary for a changed file', async () => {
    getChangedFiles.mockResolvedValue({
      files: [makeFile('src/changed.ts')],
      rawDiff: 'raw',
    })
    const { harness, session } = makeHarness()

    const result = await runWorkflow(harness)

    expect(harness.session).toHaveBeenCalledTimes(1)
    expect(session.prompt).toHaveBeenCalledTimes(1)
    expect(typeof session.prompt.mock.calls[0][0]).toBe('string')

    expect(createReporter).toHaveBeenCalledTimes(1)
    expect(postSummary).toHaveBeenCalledWith('SUMMARY')

    expect(result).toMatchObject({
      reviewed: 1,
      summaryPosted: true,
      summaryUrl: 'http://s',
      summary: 'SUMMARY',
    })
  })

  it('falls back to a default summary when the model returns empty text', async () => {
    getChangedFiles.mockResolvedValue({
      files: [makeFile('src/changed.ts')],
      rawDiff: 'raw',
    })
    const { harness } = makeHarness('   ')

    const result = (await runWorkflow(harness)) as {
      reviewed: number
      summaryPosted: boolean
    }

    expect(postSummary).toHaveBeenCalledWith(
      'CodeSentinel completed the review; see the inline comments.'
    )
    expect(result.reviewed).toBe(1)
    expect(result.summaryPosted).toBe(true)
  })

  it('propagates the error when the session prompt throws', async () => {
    getChangedFiles.mockResolvedValue({
      files: [makeFile('src/changed.ts')],
      rawDiff: 'raw',
    })
    const session = { prompt: vi.fn().mockRejectedValue(new Error('boom')) }
    const harness = { session: vi.fn().mockResolvedValue(session) }

    await expect(runWorkflow(harness)).rejects.toThrow('boom')
  })

  it('skips ignored files via the real filterFiles (ignore from env)', async () => {
    vi.stubEnv('CodeSentinel_IGNORE', '**/keep.ts')
    getChangedFiles.mockResolvedValue({
      files: [makeFile('src/keep.ts')],
      rawDiff: 'raw',
    })
    const { harness } = makeHarness()

    const result = await runWorkflow(harness)

    expect(result).toEqual({
      reviewed: 0,
      summaryPosted: false,
      message: 'No changed files to review.',
    })
    expect(harness.session).not.toHaveBeenCalled()
  })

  it('honors input payload and passes it to getChangedFiles', async () => {
    getChangedFiles.mockResolvedValue({
      files: [makeFile('src/changed.ts')],
      rawDiff: 'raw',
    })
    const { harness } = makeHarness()
    const payload = {
      platform: 'local' as const,
      baseSha: 'HEAD~1',
      headSha: 'HEAD',
      model: 'openai/gpt-4.1-mini',
    }

    await runWorkflow(harness, payload)

    expect(getChangedFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'local',
        baseSha: 'HEAD~1',
        headSha: 'HEAD',
        model: 'openai/gpt-4.1-mini',
      })
    )
  })

  it('materializes PR from prUrl, overrides config, and runs cleanup in finally', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-tok')
    getChangedFiles.mockResolvedValue({
      files: [makeFile('src/pr-change.ts')],
      rawDiff: 'raw',
    })
    const { harness } = makeHarness()
    const payload = {
      prUrl: 'https://github.com/owner/repo/pull/42',
    }

    const result = (await runWorkflow(harness, payload)) as { reviewed: number }

    expect(materializePr).toHaveBeenCalledWith(
      { host: 'github.com', owner: 'owner', repo: 'repo', number: 42 },
      'test-tok'
    )
    expect(getChangedFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: '/tmp/pr-worktree',
        baseSha: 'base-sha-123',
        headSha: 'head-sha-456',
        github: {
          owner: 'owner',
          repo: 'repo',
          prNumber: 42,
          token: 'test-tok',
        },
        platform: 'github',
      })
    )
    expect(cleanupPr).toHaveBeenCalledTimes(1)
    expect(result.reviewed).toBe(1)
  })

  it('cleans up materialized PR worktree even when session prompt throws', async () => {
    getChangedFiles.mockResolvedValue({
      files: [makeFile('src/pr-change.ts')],
      rawDiff: 'raw',
    })
    const session = { prompt: vi.fn().mockRejectedValue(new Error('crash')) }
    const harness = { session: vi.fn().mockResolvedValue(session) }
    const payload = {
      prUrl: 'owner/repo#42',
    }

    await expect(runWorkflow(harness, payload)).rejects.toThrow('crash')
    expect(cleanupPr).toHaveBeenCalledTimes(1)
  })

  it('caps review at 300 files when more than 300 files changed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const files = Array.from({ length: 305 }, (_, i) => makeFile(`src/file_${i}.ts`))
    getChangedFiles.mockResolvedValue({ files, rawDiff: 'raw' })
    const { harness } = makeHarness()

    const result = (await runWorkflow(harness, { platform: 'local' })) as {
      reviewed: number
    }

    expect(result.reviewed).toBe(300)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('capping review at 300 files')
    )
    warnSpy.mockRestore()
  })

  it('runs static analysis and includes findings in prompt and analyzer report in summary', async () => {
    getChangedFiles.mockResolvedValue({
      files: [makeFile('app/server.py')],
      rawDiff: 'raw',
    })
    runStaticAnalysis.mockResolvedValueOnce({
      findings: [
        {
          id: 'cs-bandit-1234',
          file: 'app/server.py',
          startLine: 10,
          endLine: 10,
          ruleId: 'B602',
          source: 'bandit',
          severity: 'critical',
          message: 'subprocess call with shell=True',
        },
      ],
      runs: [],
      reports: [
        {
          tool: 'bandit',
          backend: 'docker',
          status: 'ok',
          findings: 1,
          durationMs: 400,
        },
      ],
    })
    const { harness, session } = makeHarness()

    await runWorkflow(harness, { platform: 'local', staticAnalysis: true })

    expect(runStaticAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ staticAnalysis: true }),
      ['app/server.py']
    )
    const promptArg = session.prompt.mock.calls[0][0] as string
    expect(promptArg).toContain('cs-bandit-1234')
    expect(promptArg).toContain('Pre-detected findings')

    expect(postSummary).toHaveBeenCalledWith('SUMMARY', [
      {
        tool: 'bandit',
        backend: 'docker',
        status: 'ok',
        findings: 1,
        durationMs: 400,
        confirmed: 0,
        dismissed: 0,
      },
    ])
  })

  it('returns awaiting_approval when hitlMode is interactive, and completes on resume', async () => {
    const { execSync } = await import('node:child_process')
    const { promises: fsp } = await import('node:fs')
    const osp = await import('node:os')
    const pathp = await import('node:path')

    const tmpRepo = await fsp.mkdtemp(pathp.join(osp.tmpdir(), 'hitl-wf-repo-'))
    execSync('git init', { cwd: tmpRepo })
    execSync('git config user.name "Test User"', { cwd: tmpRepo })
    execSync('git config user.email "test@example.com"', { cwd: tmpRepo })
    await fsp.writeFile(pathp.join(tmpRepo, 'src.ts'), 'export const a = 1\n')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    try {
      const file = {
        fileName: 'src.ts',
        fileContent: 'export const a = 1\n',
        changedLines: [{ start: 1, end: 1 }],
        diff: 'diff --git a/src.ts b/src.ts\n@@ -1,1 +1,1 @@\n-export const a = 1\n+export const a = 2\n',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
      }
      getChangedFiles.mockResolvedValue({
        files: [file],
        rawDiff: file.diff,
      })

      const { harness, session } = makeHarness('Done')
      session.prompt.mockImplementation(async () => {
        const runId = process.env.CodeSentinel_RUN_ID!
        const collector = getOrCreateCollector(runId)
        collector.recordFinding({
          file: 'src.ts',
          startLine: 1,
          endLine: 1,
          severity: 'medium',
          message: 'fix this',
          fix: {
            replacement: 'export const a = 2',
            startLine: 1,
            endLine: 1,
          },
        })
        return { text: 'Done' }
      })

      // 1. Initial workflow run with interactive hitlMode
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const step1Result: any = await runWorkflow(harness, {
        platform: 'local',
        hitlMode: 'interactive',
        workspace: tmpRepo,
      })
      expect(step1Result.status).toBe('awaiting_approval')
      expect(step1Result.threadId).toBeDefined()
      expect(step1Result.patches).toHaveLength(1)
      const patchId = step1Result.patches[0].id

      // 2. Resume workflow
      const step2Result: any = await runWorkflow(harness, {
        resume: {
          threadId: step1Result.threadId,
          decisions: { [patchId]: 'approve' },
        },
      })

      expect(step2Result.status).toBe('completed')
      expect(step2Result.applied).toContain(patchId)

      const appliedContent = await fsp.readFile(pathp.join(tmpRepo, 'src.ts'), 'utf8')
      expect(appliedContent).toBe('export const a = 2\n')
      /* eslint-enable @typescript-eslint/no-explicit-any */
    } finally {
      await fsp.rm(tmpRepo, { recursive: true, force: true }).catch(() => {})
    }
  })
})
