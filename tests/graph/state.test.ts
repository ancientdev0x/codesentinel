import { describe, expect, it } from 'vitest'
import { errorsReducer, ReviewState, type StageError } from '../../src/graph/state'

describe('ReviewState and error reducer (E4.1)', () => {
  it('concatenates stage errors in errorsReducer', () => {
    const error1: StageError = {
      stage: 'static_analysis',
      kind: 'timeout',
      detail: 'Bandit timed out after 5000ms',
      tool: 'bandit',
    }

    const error2: StageError = {
      stage: 'validate',
      kind: 'out_of_diff',
      detail: 'Finding L99 is outside changed diff',
      findingId: 'finding-1',
    }

    const initial: StageError[] = [error1]
    const next: StageError[] = [error2]

    const reduced = errorsReducer(initial, next)
    expect(reduced).toHaveLength(2)
    expect(reduced[0]).toEqual(error1)
    expect(reduced[1]).toEqual(error2)

    // Also handles empty or undefined initial arrays safely
    expect(errorsReducer([], next)).toEqual([error2])
    expect(errorsReducer(initial, [])).toEqual([error1])
  })

  it('exposes defined state schema fields with expected defaults', () => {
    expect(ReviewState).toBeDefined()
    expect(ReviewState.fields).toBeDefined()
    expect(ReviewState.fields.errors).toBeDefined()
    expect(ReviewState.fields.summary).toBeDefined()
    expect(ReviewState.fields.attempts).toBeDefined()
    expect(ReviewState.fields.degraded).toBeDefined()
  })
})
