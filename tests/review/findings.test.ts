import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import type { LineRange } from '../../src/common/types'
import {
  dedupeFindings,
  type Finding,
  findingId,
  FindingSchema,
  onlyChanged,
} from '../../src/review/findings'

describe('Finding model & helpers', () => {
  it('generates stable 12-char hex ids for the same input', () => {
    const input = {
      source: 'bandit' as const,
      ruleId: 'B602',
      file: 'app/run.py',
      startLine: 42,
    }
    const id1 = findingId(input)
    const id2 = findingId(input)
    expect(id1).toBe(id2)
    expect(id1).toMatch(/^[0-9a-f]{12}$/)

    // Changing line changes id
    const idDiffLine = findingId({ ...input, startLine: 43 })
    expect(idDiffLine).not.toBe(id1)

    // Changing rule changes id
    const idDiffRule = findingId({ ...input, ruleId: 'B608' })
    expect(idDiffRule).not.toBe(id1)
  })

  it('validates a valid finding against FindingSchema', () => {
    const valid: Finding = {
      id: 'abc123def456',
      source: 'bandit',
      ruleId: 'B602',
      severity: 'high',
      confidence: 'high',
      file: 'app/run.py',
      startLine: 10,
      endLine: 12,
      message: 'Subprocess call with shell=True',
      cwe: 'CWE-78',
      symbol: 'execute_command',
      status: 'candidate',
      rationale: 'Unsanitized input passed to shell',
      fix: {
        replacement: 'subprocess.run([cmd], shell=False)',
        startLine: 10,
        endLine: 12,
      },
    }
    const parsed = v.parse(FindingSchema, valid)
    expect(parsed).toEqual(valid)
  })

  it('dedupes Bandit B602 and Ruff S602 on overlapping lines into a single finding', () => {
    const banditFinding: Finding = {
      id: findingId({
        source: 'bandit',
        ruleId: 'B602',
        file: 'app/run.py',
        startLine: 15,
      }),
      source: 'bandit',
      ruleId: 'B602',
      severity: 'medium',
      confidence: 'high',
      file: 'app/run.py',
      startLine: 15,
      endLine: 16,
      message: 'subprocess call with shell=True',
      cwe: 'CWE-78',
      status: 'candidate',
    }

    const ruffFinding: Finding = {
      id: findingId({
        source: 'ruff',
        ruleId: 'S602',
        file: 'app/run.py',
        startLine: 15,
      }),
      source: 'ruff',
      ruleId: 'S602',
      severity: 'high', // higher than bandit's medium
      file: 'app/run.py',
      startLine: 15,
      endLine: 17,
      message: 'subprocess call with shell=True identified',
      cwe: 'CWE-78',
      status: 'candidate',
    }

    const deduped = dedupeFindings([banditFinding, ruffFinding])
    expect(deduped).toHaveLength(1)
    const primary = deduped[0]
    expect(primary.severity).toBe('high') // Kept highest severity
    expect(primary.cwe).toBe('CWE-78')
    expect(primary.startLine).toBe(15)
    expect(primary.endLine).toBe(17)
    expect(primary.message).toContain('also reported by bandit')
  })

  it('keeps findings across different files or non-overlapping lines separate', () => {
    const f1: Finding = {
      id: 'id1',
      source: 'bandit',
      ruleId: 'B602',
      severity: 'high',
      file: 'app/run.py',
      startLine: 10,
      endLine: 12,
      message: 'shell injection',
      cwe: 'CWE-78',
      status: 'candidate',
    }
    const f2: Finding = {
      id: 'id2',
      source: 'ruff',
      ruleId: 'S602',
      severity: 'high',
      file: 'app/run.py',
      startLine: 20, // different lines
      endLine: 22,
      message: 'shell injection',
      cwe: 'CWE-78',
      status: 'candidate',
    }
    const f3: Finding = {
      id: 'id3',
      source: 'bandit',
      ruleId: 'B602',
      severity: 'high',
      file: 'app/other.py', // different file
      startLine: 10,
      endLine: 12,
      message: 'shell injection',
      cwe: 'CWE-78',
      status: 'candidate',
    }

    const deduped = dedupeFindings([f1, f2, f3])
    expect(deduped).toHaveLength(3)
  })

  describe('onlyChanged', () => {
    const changed = new Map<string, LineRange[]>([
      [
        'app/run.py',
        [
          { start: 10, end: 20 },
          { start: 30, end: 35, isPureDeletion: true },
        ],
      ],
    ])

    const makeFinding = (file: string, startLine: number, endLine: number): Finding => ({
      id: 'test',
      source: 'bandit',
      ruleId: 'B101',
      severity: 'low',
      file,
      startLine,
      endLine,
      message: 'test',
      status: 'candidate',
    })

    it('filters out findings for files not in diff', () => {
      const f = makeFinding('app/unrelated.py', 10, 20)
      expect(onlyChanged([f], changed)).toEqual([])
    })

    it('includes findings touching the start boundary', () => {
      // Finding [5, 10] touches range [10, 20] at start boundary
      const f = makeFinding('app/run.py', 5, 10)
      expect(onlyChanged([f], changed)).toEqual([f])
    })

    it('includes findings touching the end boundary', () => {
      // Finding [20, 25] touches range [10, 20] at end boundary
      const f = makeFinding('app/run.py', 20, 25)
      expect(onlyChanged([f], changed)).toEqual([f])
    })

    it('includes findings strictly inside the range', () => {
      const f = makeFinding('app/run.py', 12, 14)
      expect(onlyChanged([f], changed)).toEqual([f])
    })

    it('excludes findings strictly before or strictly after the range', () => {
      const before = makeFinding('app/run.py', 1, 9)
      const after = makeFinding('app/run.py', 21, 29)
      expect(onlyChanged([before, after], changed)).toEqual([])
    })

    it('excludes findings that only overlap with pure deletions', () => {
      // Line 30-35 was pure deletion
      const f = makeFinding('app/run.py', 31, 33)
      expect(onlyChanged([f], changed)).toEqual([])
    })
  })
})
