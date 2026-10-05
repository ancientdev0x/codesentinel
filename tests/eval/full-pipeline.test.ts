import { describe, expect, it } from 'vitest'
import { buildAggregateReport, computeRunMetrics } from '../../scripts/eval-full'
import type { Finding } from '../../src/review/findings'
import type { Patch } from '../../src/review/patch'

describe('Full-Pipeline Evaluation Metrics (E7.3)', () => {
  it('computes TP, FP, FN, precision, recall, triage value, and patch quality correctly', async () => {
    // Simulated confirmed findings
    const confirmedFindings: Finding[] = [
      {
        id: 'f1',
        file: 'app/db.py',
        line: 2,
        cwe: 'CWE-89',
        severity: 'critical',
        message: 'SQL Injection',
        status: 'confirmed',
      },
      {
        id: 'f2',
        file: 'app/calc.py',
        line: 2,
        cwe: 'CWE-95',
        severity: 'critical',
        message: 'Eval execution',
        status: 'confirmed',
      },
      {
        id: 'f3',
        file: 'app/clean_math.py',
        line: 5,
        severity: 'low',
        message: 'False alarm on clean file',
        status: 'confirmed',
      },
      {
        id: 'f4',
        file: 'app/auth_logic.py',
        line: 2,
        severity: 'high',
        message: 'Inverted admin authorization check',
        status: 'confirmed',
      },
    ]

    const allDetectorFindings: Finding[] = [
      ...confirmedFindings,
      {
        id: 'f5',
        file: 'app/calc.py',
        line: 10,
        severity: 'low',
        message: 'Dismissed FP from detector',
        status: 'dismissed',
      },
      {
        id: 'f6',
        file: 'app/calc.py',
        line: 15,
        severity: 'low',
        message: 'Another dismissed FP',
        status: 'dismissed',
      },
    ]

    const patches: Patch[] = [
      {
        id: 'p1',
        findingId: 'f1',
        file: 'app/db.py',
        diff: '--- a/app/db.py\n+++ b/app/db.py\n@@ -2,1 +2,1 @@\n-cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")\n+cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))',
        stats: { added: 1, removed: 1 },
      },
    ]

    const runMetrics = await computeRunMetrics(
      1,
      'openai-codex/gpt-5.6-luna',
      48000,
      confirmedFindings,
      allDetectorFindings,
      patches,
      '/tmp/workspace',
      { llm_triage: 2, validate: 2 },
      [],
      { input: 20000, output: 4000, total: 24000 },
      ['ingest', 'extract_ast', 'static_analysis', 'llm_triage', 'validate', 'report']
    )

    expect(runMetrics.runIndex).toBe(1)
    expect(runMetrics.tp).toBeGreaterThanOrEqual(3)
    expect(runMetrics.fp).toBe(1) // 1 in clean_math.py
    expect(runMetrics.dismissedDetectorCount).toBe(2)
    expect(runMetrics.llmRegressionsCaught).toBeGreaterThanOrEqual(1)
    expect(runMetrics.patchQualityRate).toBe(1.0)
    expect(runMetrics.selfCorrectionTriggered).toBe(true)
    expect(runMetrics.selfCorrectionRecovered).toBe(true)
  })

  it('aggregates multiple runs into a markdown table with p50/p95 latency and averages', () => {
    const run1 = {
      runIndex: 1,
      model: 'openai-codex/gpt-5.6-luna',
      wallTimeMs: 45000,
      nodeSequence: ['ingest', 'report'],
      attempts: { llm_triage: 1 },
      degraded: [],
      tokens: { total: 20000 },
      rawDetectorCount: 20,
      dismissedDetectorCount: 2,
      confirmedFindingsCount: 18,
      tp: 18,
      fp: 0,
      fn: 3,
      precision: 1.0,
      recall: 0.857,
      llmRegressionsCaught: 3,
      llmRegressionsTotal: 3,
      patchesAttempted: 5,
      patchesValid: 5,
      patchQualityRate: 1.0,
      selfCorrectionTriggered: false,
      selfCorrectionRecovered: false,
    }

    const run2 = {
      runIndex: 2,
      model: 'openai-codex/gpt-5.6-luna',
      wallTimeMs: 52000,
      nodeSequence: ['ingest', 'report'],
      attempts: { llm_triage: 2 },
      degraded: [],
      tokens: { total: 26000 },
      rawDetectorCount: 20,
      dismissedDetectorCount: 3,
      confirmedFindingsCount: 19,
      tp: 19,
      fp: 0,
      fn: 2,
      precision: 1.0,
      recall: 0.905,
      llmRegressionsCaught: 3,
      llmRegressionsTotal: 3,
      patchesAttempted: 6,
      patchesValid: 6,
      patchQualityRate: 1.0,
      selfCorrectionTriggered: true,
      selfCorrectionRecovered: true,
    }

    const aggregate = buildAggregateReport('openai-codex/gpt-5.6-luna', 'mock-sha', [
      run1,
      run2,
    ])

    expect(aggregate.runCount).toBe(2)
    expect(aggregate.avgPrecision).toBe(1.0)
    expect(aggregate.avgRecall).toBeCloseTo(0.881, 2)
    expect(aggregate.triageDismissedAvg).toBe(2.5)
    expect(aggregate.patchQualityRateAvg).toBe(1.0)
    expect(aggregate.selfCorrectionRate).toBe(0.5)
    expect(aggregate.markdownTable).toContain('| Run 1 |')
    expect(aggregate.markdownTable).toContain('| Run 2 |')
    expect(aggregate.markdownTable).toContain('| **Avg** |')
  })
})
