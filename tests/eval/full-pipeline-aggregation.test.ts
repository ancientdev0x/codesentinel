import { describe, expect, it } from 'vitest'
import {
  buildAggregateReport,
  scoreFindings,
  loadLabels,
  type FullRunReport,
} from '../../scripts/eval-full'
import type { Finding } from '../../src/review/findings'

describe('Full-Pipeline Evaluation Aggregation Unit Test (E7.3)', () => {
  it('computes TP, FP, FN, precision, recall, and duplicate findings correctly', () => {
    const labels = loadLabels()

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
      {
        id: 'f5',
        file: 'app/db.py',
        line: 2,
        cwe: 'CWE-89',
        severity: 'critical',
        message: 'Duplicate SQL Injection report',
        status: 'confirmed',
      },
      {
        id: 'f6',
        file: 'web/nonexistent.ts',
        line: 10,
        severity: 'medium',
        message: 'Unmatched finding',
        status: 'confirmed',
      },
    ]

    const scored = scoreFindings(confirmedFindings, labels)

    expect(scored.tpCount).toBe(3) // db.py, calc.py, auth_logic.py
    expect(scored.fpCount).toBe(2) // 1 in clean_math.py, 1 unmatched
    expect(scored.duplicateCount).toBe(1) // duplicate db.py
    expect(scored.precision).toBeCloseTo(3 / 5, 2)
    expect(scored.logicRegressions['app/auth_logic.py:2']).toBe('caught')
    expect(scored.logicRegressions['app/data_validator.py:2']).toBe('missed')
  })

  it('aggregates multiple runs into a markdown table with p50/p95 latency and averages', () => {
    const run1: FullRunReport = {
      runIndex: 1,
      model: 'openai-codex/gpt-5.6-luna',
      reasoningEffort: 'medium',
      wallTimeMs: 45000,
      nodeSequence: ['ingest', 'report'],
      attempts: { llm_triage: 1 },
      degraded: [],
      tokensPerAttempt: [
        { attempt: 1, input: 10000, output: 2000, cacheRead: 8000, total: 20000 },
      ],
      tokensTotal: { input: 10000, output: 2000, cacheRead: 8000, total: 20000 },
      findings: [],
      patchApplyResults: [
        { patchId: 'p1', file: 'app/db.py', linesChanged: 2, gitApplyCheck: 'passed' },
      ],
      metrics: {
        totalLabels: 25,
        defectLabelsCount: 21,
        cleanLabelsCount: 4,
        tpCount: 18,
        fpCount: 2,
        duplicateCount: 1,
        fnCount: 3,
        precision: 18 / 20,
        recall: 18 / 21,
        logicRegressions: {
          'app/auth_logic.py:2': 'caught',
          'app/data_validator.py:2': 'missed',
          'web/permission.ts:2': 'caught',
        },
        selfCorrection: {
          triggered: false,
          recovered: false,
        },
      },
    }

    const run2: FullRunReport = {
      runIndex: 2,
      model: 'openai-codex/gpt-5.6-luna',
      reasoningEffort: 'medium',
      wallTimeMs: 52000,
      nodeSequence: ['ingest', 'report'],
      attempts: { llm_triage: 2 },
      degraded: [],
      tokensPerAttempt: [
        { attempt: 1, input: 12000, output: 2500, cacheRead: 9000, total: 23500 },
      ],
      tokensTotal: { input: 12000, output: 2500, cacheRead: 9000, total: 23500 },
      findings: [],
      patchApplyResults: [
        { patchId: 'p1', file: 'app/db.py', linesChanged: 2, gitApplyCheck: 'passed' },
      ],
      metrics: {
        totalLabels: 25,
        defectLabelsCount: 21,
        cleanLabelsCount: 4,
        tpCount: 19,
        fpCount: 1,
        duplicateCount: 2,
        fnCount: 2,
        precision: 19 / 20,
        recall: 19 / 21,
        logicRegressions: {
          'app/auth_logic.py:2': 'caught',
          'app/data_validator.py:2': 'caught',
          'web/permission.ts:2': 'caught',
        },
        selfCorrection: {
          triggered: true,
          recovered: true,
        },
      },
    }

    const aggregate = buildAggregateReport('openai-codex/gpt-5.6-luna', 'mock-sha', [
      run1,
      run2,
    ])

    expect(aggregate.runCount).toBe(2)
    expect(aggregate.avgPrecision).toBeCloseTo(0.925, 2)
    expect(aggregate.avgRecall).toBeCloseTo(0.88, 2)
    expect(aggregate.patchQualityRateAvg).toBe(1.0)
    expect(aggregate.selfCorrectionRate).toBe(0.5)
    expect(aggregate.markdownTable).toContain('| Run 1 |')
    expect(aggregate.markdownTable).toContain('| Run 2 |')
  })
})
