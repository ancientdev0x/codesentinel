import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL,
  DEFAULT_QA_LEAD_MODEL,
  resolveModel,
  resolveQaDriverModel,
  resolveQaLeadModel,
} from '../../src/common/models'

describe('resolveModel (review + mention)', () => {
  it('defaults, reads CodeSentinel_MODEL, and honours the override', () => {
    expect(resolveModel({})).toBe(DEFAULT_MODEL)
    expect(resolveModel({ CodeSentinel_MODEL: 'x/y' })).toBe('x/y')
    expect(resolveModel({ CodeSentinel_MODEL: 'x/y' }, 'over/ride')).toBe('over/ride')
    expect(resolveModel({ CodeSentinel_MODEL: '' })).toBe(DEFAULT_MODEL) // empty env is treated as unset
  })
})

describe('resolveQaLeadModel (qa lead + healer)', () => {
  it('precedence: override > CodeSentinel_QA_MODEL > CodeSentinel_MODEL > default', () => {
    expect(resolveQaLeadModel({})).toBe(DEFAULT_QA_LEAD_MODEL)
    expect(resolveQaLeadModel({ CodeSentinel_MODEL: 'base/m' })).toBe('base/m')
    expect(
      resolveQaLeadModel({ CodeSentinel_MODEL: 'base/m', CodeSentinel_QA_MODEL: 'qa/m' })
    ).toBe('qa/m')
    expect(resolveQaLeadModel({ CodeSentinel_QA_MODEL: 'qa/m' }, 'over/ride')).toBe(
      'over/ride'
    )
  })
})

describe('resolveQaDriverModel (per-flow drivers)', () => {
  it('inherits the lead knobs so one env var moves the whole system', () => {
    // Zero-config keeps the cheap driver default (opus lead + sonnet driver split).
    expect(resolveQaDriverModel({})).toBe(DEFAULT_MODEL)
    // Setting CodeSentinel_MODEL / CodeSentinel_QA_MODEL moves the drivers too (the bug this fixes).
    expect(resolveQaDriverModel({ CodeSentinel_MODEL: 'base/m' })).toBe('base/m')
    expect(resolveQaDriverModel({ CodeSentinel_QA_MODEL: 'qa/m' })).toBe('qa/m')
    // Dedicated override wins and lets you keep a cheaper driver tier.
    expect(
      resolveQaDriverModel({
        CodeSentinel_QA_MODEL: 'qa/m',
        CodeSentinel_QA_DRIVER_MODEL: 'cheap/m',
      })
    ).toBe('cheap/m')
  })
})
