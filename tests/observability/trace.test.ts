import { describe, expect, it } from 'vitest'
import {
  summarizeDelta,
  summarizeState,
  updateActiveTrace,
  withNodeSpan,
  withTraceContext,
} from '../../src/observability/trace'

describe('Trace and node spans (E6.2)', () => {
  it('summarizes state with counts and avoids full raw file contents', () => {
    const state = {
      files: ['a.py', 'b.ts'],
      findings: [1, 2, 3],
      longText: 'x'.repeat(500),
      count: 42,
      flags: { enabled: true, mode: 'strict' },
    }

    const summary = summarizeState(state)
    expect(summary.files_count).toBe(2)
    expect(summary.findings_count).toBe(3)
    expect(summary.count).toBe(42)
    expect(summary.flags_keys).toBe(2)
    expect((summary.longText as string).length).toBeLessThan(300)
    expect(summary.longText).toContain('...')
  })

  it('summarizeDelta delegates to summarizeState', () => {
    const delta = { addedFindings: [1, 2] }
    expect(summarizeDelta(delta)).toEqual({ addedFindings_count: 2 })
  })

  it('runs node function wrapped in withNodeSpan', async () => {
    const nodeFn = async (state: {
      counter: number
      attempts?: Record<string, number>
    }) => {
      return { counter: state.counter + 1 }
    }

    const wrapped = withNodeSpan('test_node', nodeFn)
    const res = await wrapped({ counter: 10, attempts: { test_node: 1 } })
    expect(res).toEqual({ counter: 11 })
  })

  it('propagates errors when wrapped node throws', async () => {
    const failingNode = async () => {
      throw new Error('node failed')
    }

    const wrapped = withNodeSpan('failing_node', failingNode)
    await expect(wrapped({ attempts: {} })).rejects.toThrow('node failed')
  })

  it('safely handles updateActiveTrace', () => {
    expect(() => {
      updateActiveTrace({
        name: 'review',
        sessionId: 'pr-42',
        tags: ['github', 'claude-3-5-sonnet'],
        metadata: { repo: 'owner/repo', pr: 42 },
      })
    }).not.toThrow()
  })

  it('runs within withTraceContext', () => {
    const res = withTraceContext({ sessionId: 'session-123' }, () => {
      return 100
    })
    expect(res).toBe(100)
  })
})
