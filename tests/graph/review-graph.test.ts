import { describe, expect, it, vi } from 'vitest'
import { deleteCollector, getOrCreateCollector } from '../../src/graph/collector'
import { buildReviewGraph } from '../../src/graph/review-graph'
import { resolveReviewConfig } from '../../src/review/config'
import type { ReviewFileWithDiff } from '../../src/review/diff'

describe('buildReviewGraph cycle and self-correction engine (E4.5, E4.6)', () => {
  const baseCfg = resolveReviewConfig({ platform: 'local', workspace: process.cwd() }, {})

  const testFile: ReviewFileWithDiff = {
    fileName: 'src/handler.ts',
    fileContent: 'export const run = () => { eval("test"); }\n',
    diff: '@@ -1,1 +1,1 @@\n+export const run = () => { eval("test"); }',
    changedLines: [{ start: 1, end: 1 }],
  }

  it('1. Happy path: each node visited once, report receives confirmed findings', async () => {
    const runId = 'test-happy-path'
    process.env.CodeSentinel_RUN_ID = runId
    const collector = getOrCreateCollector(runId)
    collector.clear()

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: vi.fn().mockResolvedValue({
          files: [testFile],
          rawDiff: testFile.diff,
        }),
      },
      extractAst: {
        extractAllFragments: vi.fn().mockReturnValue([]),
        runAstChecks: vi.fn().mockReturnValue([]),
      },
      staticAnalysis: {
        runStaticAnalysis: vi.fn().mockResolvedValue({
          findings: [],
          runs: [{ status: 'ok', tool: 'bandit', durationMs: 50 }],
          reports: [],
        }),
      },
      llmTriage: {
        session: { prompt: vi.fn().mockResolvedValue({ text: 'Happy path' }) },
        tracedPrompt: vi.fn().mockImplementation(async () => {
          collector.recordFinding({
            file: 'src/handler.ts',
            startLine: 1,
            endLine: 1,
            severity: 'high',
            message: 'Insecure eval sink',
            cwe: 'CWE-95',
          })
          return { text: 'Happy path review complete.' }
        }),
      },
      report: {
        createReporter: () =>
          ({
            postReviewComment: vi.fn().mockResolvedValue('url-c'),
            postSummary: vi.fn().mockResolvedValue('url-s'),
          }) as any,
      },
    })

    const finalState = await graph.invoke(
      { cfg: { ...baseCfg, astChecks: true, staticAnalysis: true } },
      { configurable: { thread_id: runId }, recursionLimit: 25 }
    )

    expect(finalState.attempts.ingest).toBe(1)
    expect(finalState.attempts.extract_ast).toBe(1)
    expect(finalState.attempts.static_analysis).toBe(1)
    expect(finalState.attempts.llm_triage).toBe(1)
    expect(finalState.attempts.validate).toBe(1)
    expect(finalState.attempts.report).toBe(1)
    expect(finalState.llmFindings).toHaveLength(1)
    expect(finalState.summary).toContain('Happy path review complete.')
    expect(finalState.nodeSequence).toEqual([
      'ingest',
      'extract_ast',
      'static_analysis',
      'llm_triage',
      'validate',
      'human_review',
      'report',
    ])

    deleteCollector(runId)
  })

  it('2. Self-correction: out-of-diff finding is detected, hints returned, fixed on attempt 2', async () => {
    const runId = 'test-self-correction'
    process.env.CodeSentinel_RUN_ID = runId
    const collector = getOrCreateCollector(runId)
    collector.clear()

    let attemptCount = 0
    let receivedHint = ''

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: vi.fn().mockResolvedValue({
          files: [testFile],
          rawDiff: testFile.diff,
        }),
      },
      extractAst: {
        extractAllFragments: vi.fn().mockReturnValue([]),
        runAstChecks: vi.fn().mockReturnValue([]),
      },
      staticAnalysis: {
        runStaticAnalysis: vi.fn().mockResolvedValue({
          findings: [],
          runs: [],
          reports: [],
        }),
      },
      llmTriage: {
        session: { prompt: vi.fn().mockResolvedValue({ text: 'Self-correction' }) },
        tracedPrompt: vi.fn().mockImplementation(async (_session, prompt) => {
          attemptCount++
          if (attemptCount === 1) {
            // Attempt 1: record out-of-diff finding at line 99
            collector.recordFinding({
              file: 'src/handler.ts',
              startLine: 99,
              endLine: 99,
              severity: 'high',
              message: 'Out of diff finding',
            })
            return { text: 'Attempt 1 summary.' }
          } else {
            // Attempt 2: self-correct using hint
            receivedHint = prompt
            collector.clear()
            collector.recordFinding({
              file: 'src/handler.ts',
              startLine: 1,
              endLine: 1,
              severity: 'high',
              message: 'Corrected line 1 finding',
            })
            return { text: 'Attempt 2 corrected summary.' }
          }
        }),
      },
      report: {
        createReporter: () =>
          ({
            postReviewComment: vi.fn().mockResolvedValue('url'),
            postSummary: vi.fn().mockResolvedValue('url'),
          }) as any,
      },
    })

    const finalState = await graph.invoke(
      { cfg: { ...baseCfg, maxAttempts: 3 } },
      { configurable: { thread_id: runId }, recursionLimit: 25 }
    )

    expect(finalState.attempts.validate).toBe(2)
    expect(finalState.attempts.llm_triage).toBe(2)
    expect(receivedHint).toContain('changed lines are 1-1')
    expect(finalState.llmFindings).toHaveLength(1)
    expect(finalState.llmFindings[0].startLine).toBe(1)
    expect(finalState.nodeSequence).toEqual([
      'ingest',
      'extract_ast',
      'static_analysis',
      'llm_triage',
      'validate',
      'failure_analysis',
      'llm_triage',
      'validate',
      'human_review',
      'report',
    ])

    deleteCollector(runId)
  })

  it('3. Bounded: stops after maxAttempts when invalid findings persist, degrades and reports', async () => {
    const runId = 'test-bounded'
    process.env.CodeSentinel_RUN_ID = runId
    const collector = getOrCreateCollector(runId)
    collector.clear()

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: vi.fn().mockResolvedValue({
          files: [testFile],
          rawDiff: testFile.diff,
        }),
      },
      extractAst: {
        extractAllFragments: vi.fn().mockReturnValue([]),
        runAstChecks: vi.fn().mockReturnValue([]),
      },
      staticAnalysis: {
        runStaticAnalysis: vi.fn().mockResolvedValue({
          findings: [],
          runs: [],
          reports: [],
        }),
      },
      llmTriage: {
        session: { prompt: vi.fn().mockResolvedValue({ text: 'Bounded' }) },
        tracedPrompt: vi.fn().mockImplementation(async () => {
          collector.clear()
          // Always invalid out-of-diff finding
          collector.recordFinding({
            file: 'src/handler.ts',
            startLine: 999,
            endLine: 999,
            severity: 'critical',
            message: 'Persistently invalid finding',
          })
          return { text: 'Summary attempt' }
        }),
      },
      report: {
        createReporter: () =>
          ({
            postReviewComment: vi.fn().mockResolvedValue('url'),
            postSummary: vi.fn().mockResolvedValue('url'),
          }) as any,
      },
    })

    const finalState = await graph.invoke(
      { cfg: { ...baseCfg, maxAttempts: 3 } },
      { configurable: { thread_id: runId }, recursionLimit: 25 }
    )

    expect(finalState.attempts.llm_triage).toBe(3)
    expect(finalState.degraded).toContain('llm_triage')
    expect(finalState.llmFindings).toHaveLength(0)
    expect(finalState.attempts.report).toBe(1)

    deleteCollector(runId)
  })

  it('4. Tool recovery: fake Bandit times out, retries with doubled timeout and succeeds', async () => {
    const runId = 'test-tool-recovery'
    process.env.CodeSentinel_RUN_ID = runId
    let staticAttempt = 0
    let recordedTimeout = 0

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: vi.fn().mockResolvedValue({
          files: [testFile],
          rawDiff: testFile.diff,
        }),
      },
      staticAnalysis: {
        runStaticAnalysis: vi.fn().mockImplementation(async (cfg) => {
          staticAttempt++
          recordedTimeout = cfg.analyzerTimeoutMs
          if (staticAttempt === 1) {
            return {
              findings: [],
              runs: [{ status: 'timeout', tool: 'bandit', durationMs: 2000 }],
              reports: [],
            }
          }
          return {
            findings: [],
            runs: [{ status: 'ok', tool: 'bandit', durationMs: 1500 }],
            reports: [],
          }
        }),
      },
      llmTriage: {
        session: { prompt: vi.fn().mockResolvedValue({ text: 'Review done.' }) },
        tracedPrompt: vi.fn().mockResolvedValue({ text: 'Review done.' }),
      },
      report: {
        createReporter: () =>
          ({
            postReviewComment: vi.fn().mockResolvedValue('url'),
            postSummary: vi.fn().mockResolvedValue('url'),
          }) as any,
      },
    })

    const finalState = await graph.invoke(
      { cfg: { ...baseCfg, staticAnalysis: true, analyzerTimeoutMs: 2000 } },
      { configurable: { thread_id: runId }, recursionLimit: 25 }
    )

    expect(staticAttempt).toBe(2)
    expect(recordedTimeout).toBe(4000)
    expect(finalState.attempts.static_analysis).toBe(2)
    expect(finalState.attempts.report).toBe(1)
  })

  it('5. Docker fallback: unavailable docker leads to retry on host backend', async () => {
    const runId = 'test-docker-fallback'
    process.env.CodeSentinel_RUN_ID = runId
    let staticAttempt = 0
    let lastBackend = ''

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: vi.fn().mockResolvedValue({
          files: [testFile],
          rawDiff: testFile.diff,
        }),
      },
      staticAnalysis: {
        runStaticAnalysis: vi.fn().mockImplementation(async (cfg) => {
          staticAttempt++
          lastBackend = cfg.sandbox
          if (staticAttempt === 1) {
            return {
              findings: [],
              runs: [
                {
                  status: 'error',
                  tool: 'bandit',
                  stderr: 'Cannot connect to the Docker daemon',
                  durationMs: 100,
                },
              ],
              reports: [],
            }
          }
          return {
            findings: [],
            runs: [{ status: 'ok', tool: 'bandit', durationMs: 50 }],
            reports: [],
          }
        }),
      },
      llmTriage: {
        session: { prompt: vi.fn().mockResolvedValue({ text: 'Review complete.' }) },
        tracedPrompt: vi.fn().mockResolvedValue({ text: 'Review complete.' }),
      },
      report: {
        createReporter: () =>
          ({
            postReviewComment: vi.fn().mockResolvedValue('url'),
            postSummary: vi.fn().mockResolvedValue('url'),
          }) as any,
      },
    })

    const finalState = await graph.invoke(
      { cfg: { ...baseCfg, staticAnalysis: true, sandbox: 'docker' } },
      { configurable: { thread_id: runId }, recursionLimit: 25 }
    )

    expect(staticAttempt).toBe(2)
    expect(lastBackend).toBe('host')
    expect(finalState.attempts.static_analysis).toBe(2)
  })

  it('6. Never-throws: every node dependency throws and graph still reaches report with degraded', async () => {
    const runId = 'test-never-throws'
    process.env.CodeSentinel_RUN_ID = runId

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: vi.fn().mockRejectedValue(new Error('Git failure in ingest')),
      },
      extractAst: {
        extractAllFragments: vi.fn().mockImplementation(() => {
          throw new Error('AST crash')
        }),
      },
      staticAnalysis: {
        runStaticAnalysis: vi.fn().mockRejectedValue(new Error('Analyzer crash')),
      },
      llmTriage: {
        tracedPrompt: vi.fn().mockRejectedValue(new Error('Model outage')),
      },
      report: {
        createReporter: () =>
          ({
            postReviewComment: vi.fn().mockRejectedValue(new Error('API rate limit')),
            postSummary: vi.fn().mockRejectedValue(new Error('API rate limit')),
          }) as any,
      },
    })

    // Graph must not throw, must terminate gracefully at END
    const finalState = await graph.invoke(
      { cfg: { ...baseCfg, astChecks: true, staticAnalysis: true } },
      { configurable: { thread_id: runId }, recursionLimit: 25 }
    )

    expect(finalState).toBeDefined()
    expect(finalState.attempts.ingest).toBe(1)
    expect(finalState.errors.length).toBeGreaterThan(0)
  })

  it('generates mermaid flowchart diagram', () => {
    const graph = buildReviewGraph()
    const mermaid = (graph as any).getGraph().drawMermaid()
    expect(typeof mermaid).toBe('string')
    expect(mermaid).toContain('ingest')
    expect(mermaid).toContain('failure_analysis')
    expect(mermaid).toContain('report')
  })
})
