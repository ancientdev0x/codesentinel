import { describe, expect, it } from 'vitest'
import { failureAnalysis } from '../../src/graph/nodes/failure-analysis'
import type { ReviewStateType } from '../../src/graph/state'
import { resolveReviewConfig } from '../../src/review/config'

describe('failureAnalysis deterministic error classification & recovery (E4.4)', () => {
  const baseCfg = resolveReviewConfig({ platform: 'local', workspace: process.cwd() }, {})

  const createState = (overrides: Partial<ReviewStateType> = {}): ReviewStateType => ({
    cfg: { ...baseCfg, maxAttempts: 3, analyzerTimeoutMs: 5000 },
    files: [],
    fragments: [],
    staticFindings: [],
    llmFindings: [],
    summary: 'Initial summary',
    attempts: {},
    errors: [],
    degraded: [],
    recovery: null,
    approvals: {},
    handledErrorCount: 0,
    ...overrides,
  })

  it('handles timeout in static_analysis by doubling timeout and retrying', async () => {
    const state = createState({
      attempts: { static_analysis: 1 },
      errors: [
        {
          stage: 'static_analysis',
          kind: 'timeout',
          tool: 'bandit',
          detail: 'Bandit timed out',
        },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBe('static_analysis')
    expect(update.recovery?.adjust?.timeoutMs).toBe(10000)
    expect(update.handledErrorCount).toBe(1)
  })

  it('degrades tool if static_analysis timeout retry bound is exceeded', async () => {
    const state = createState({
      attempts: { static_analysis: 2 },
      errors: [
        {
          stage: 'static_analysis',
          kind: 'timeout',
          tool: 'bandit',
          detail: 'Bandit timed out again',
        },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBeNull()
    expect(update.degraded).toContain('bandit')
  })

  it('handles unavailable docker by retrying with host backend', async () => {
    const state = createState({
      cfg: { ...baseCfg, sandbox: 'docker' },
      attempts: { static_analysis: 1 },
      errors: [
        {
          stage: 'static_analysis',
          kind: 'unavailable',
          tool: 'bandit',
          detail: 'Docker daemon is not running',
        },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBe('static_analysis')
    expect(update.recovery?.adjust?.backend).toBe('host')
  })

  it('degrades tool immediately on host crash / unavailable', async () => {
    const state = createState({
      cfg: { ...baseCfg, sandbox: 'host' },
      attempts: { static_analysis: 1 },
      errors: [
        {
          stage: 'static_analysis',
          kind: 'crash',
          tool: 'ruff',
          detail: 'Binary crashed with SIGSEGV',
        },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBeNull()
    expect(update.degraded).toContain('ruff')
  })

  it('retries llm_triage with violation hints on out_of_diff error', async () => {
    const state = createState({
      attempts: { llm_triage: 1 },
      errors: [
        {
          stage: 'validate',
          kind: 'out_of_diff',
          findingId: 'f1',
          detail: 'Finding L99 is outside changed diff',
        },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBe('llm_triage')
    expect(update.recovery?.hints).toHaveLength(1)
    expect(update.recovery?.hints[0]).toContain(
      'Finding f1: Finding L99 is outside changed diff'
    )
  })

  it('degrades llm_triage when maxAttempts (3) is exceeded', async () => {
    const state = createState({
      attempts: { llm_triage: 3 },
      errors: [
        {
          stage: 'validate',
          kind: 'invalid_output',
          detail: 'Schema validation failed',
        },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBeNull()
    expect(update.degraded).toContain('llm_triage')
  })

  it('retries llm_triage on provider_error up to 2 times', async () => {
    const state = createState({
      attempts: { llm_triage: 1 },
      errors: [
        {
          stage: 'llm_triage',
          kind: 'provider_error',
          detail: '429 Too Many Requests',
        },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBe('llm_triage')
    expect(update.recovery?.hints[0]).toContain('429 Too Many Requests')
  })

  it('retries empty_review once', async () => {
    const state = createState({
      attempts: { llm_triage: 1 },
      errors: [
        {
          stage: 'validate',
          kind: 'empty_review',
          detail: 'Review summary is empty',
        },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBe('llm_triage')
    expect(update.recovery?.hints[0]).toContain('Review summary was empty')
  })

  it('records static_analysis as degraded when all tools in analyzer stage time out or fail', async () => {
    const state = createState({
      attempts: { static_analysis: 2 },
      analyzerReports: [
        {
          tool: 'bandit',
          backend: 'docker',
          status: 'timeout',
          findings: 0,
          durationMs: 5000,
        },
        {
          tool: 'ruff',
          backend: 'docker',
          status: 'timeout',
          findings: 0,
          durationMs: 5000,
        },
        {
          tool: 'tsc',
          backend: 'host',
          status: 'timeout',
          findings: 0,
          durationMs: 5000,
        },
      ],
      errors: [
        {
          stage: 'static_analysis',
          kind: 'timeout',
          tool: 'bandit',
          detail: 'Bandit timeout',
        },
        {
          stage: 'static_analysis',
          kind: 'timeout',
          tool: 'ruff',
          detail: 'Ruff timeout',
        },
        { stage: 'static_analysis', kind: 'timeout', tool: 'tsc', detail: 'tsc timeout' },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBeNull()
    expect(update.degraded).toContain('bandit')
    expect(update.degraded).toContain('ruff')
    expect(update.degraded).toContain('tsc')
    expect(update.degraded).toContain('static_analysis')
  })

  it('does NOT record static_analysis as degraded if at least one tool succeeded', async () => {
    const state = createState({
      attempts: { static_analysis: 2 },
      analyzerReports: [
        {
          tool: 'bandit',
          backend: 'docker',
          status: 'timeout',
          findings: 0,
          durationMs: 5000,
        },
        { tool: 'ruff', backend: 'docker', status: 'ok', findings: 2, durationMs: 120 },
      ],
      errors: [
        {
          stage: 'static_analysis',
          kind: 'timeout',
          tool: 'bandit',
          detail: 'Bandit timeout',
        },
      ],
    })

    const update = await failureAnalysis(state)
    expect(update.recovery?.retry).toBeNull()
    expect(update.degraded).toContain('bandit')
    expect(update.degraded).not.toContain('static_analysis')
  })
})
