import { describe, expect, it } from 'vitest'
import { runDeterministicEval } from '../../scripts/deterministic'

describe('Deterministic Evaluation (E7.2)', () => {
  it('runs deterministic analyzers and verifies recall/clean file thresholds', async () => {
    const report = await runDeterministicEval({ sandbox: 'auto' })

    // Print evaluation markdown table to console
    console.log('\n--- CodeSentinel Deterministic Evaluation Results ---')
    console.log(report.markdownTable)
    console.log('-----------------------------------------------------\n')

    expect(report.deterministicLabelsCount).toBeGreaterThanOrEqual(15)

    // Zero false positives on clean files
    expect(report.cleanFindingsCount).toBe(0)

    // Union recall >= 0.9 (90%)
    expect(report.union.recall).toBeGreaterThanOrEqual(0.9)
  }, 120000)
})
