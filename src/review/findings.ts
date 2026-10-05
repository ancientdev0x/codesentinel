import { createHash } from 'node:crypto'
import * as v from 'valibot'
import type { LineRange } from '../common/types'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type FindingSource = 'bandit' | 'ruff' | 'ast-grep' | 'tsc' | 'oxlint' | 'llm'
export type FindingStatus = 'candidate' | 'confirmed' | 'dismissed'

export interface Finding {
  id: string // stable hash, see findingId()
  source: FindingSource
  ruleId: string // e.g. B602, S608, py-eval-sink, llm
  severity: Severity
  confidence?: 'high' | 'medium' | 'low'
  file: string // repo-relative
  startLine: number
  endLine: number
  message: string
  cwe?: string // "CWE-78"
  symbol?: string // enclosing function/class from E2
  status: FindingStatus
  rationale?: string // LLM triage reason (confirm/dismiss)
  fix?: { replacement: string; startLine: number; endLine: number } // for E5 patches
}

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

export const FindingSchema = v.object({
  id: v.string(),
  source: v.picklist(['bandit', 'ruff', 'ast-grep', 'tsc', 'oxlint', 'llm']),
  ruleId: v.string(),
  severity: v.picklist(['critical', 'high', 'medium', 'low', 'info']),
  confidence: v.optional(v.picklist(['high', 'medium', 'low'])),
  file: v.string(),
  startLine: v.number(),
  endLine: v.number(),
  message: v.string(),
  cwe: v.optional(v.string()),
  symbol: v.optional(v.string()),
  status: v.picklist(['candidate', 'confirmed', 'dismissed']),
  rationale: v.optional(v.string()),
  fix: v.optional(
    v.object({
      replacement: v.string(),
      startLine: v.number(),
      endLine: v.number(),
    })
  ),
})

export const findingId = (f: Pick<Finding, 'source' | 'ruleId' | 'file' | 'startLine'>) =>
  createHash('sha1')
    .update(`${f.source}|${f.ruleId}|${f.file}|${f.startLine}`)
    .digest('hex')
    .slice(0, 12)

/**
 * Normalizes a finding file path to be repo-relative.
 * Removes leading slashes, `./`, and workspace root prefixes.
 */
export const normalizeFindingPath = (filePath: string, workspace?: string): string => {
  let p = filePath.replace(/\\/g, '/').trim()
  if (workspace) {
    const normWs = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
    if (p.startsWith(`${normWs}/`)) {
      p = p.slice(normWs.length + 1)
    } else if (p === normWs) {
      p = ''
    } else if (p.startsWith('/')) {
      // If path is absolute but workspace prefix wasn't direct match, compute relative
      const wsSegments = normWs.split('/').filter(Boolean)
      const pSegments = p.split('/').filter(Boolean)
      let common = 0
      while (
        common < wsSegments.length &&
        common < pSegments.length &&
        wsSegments[common] === pSegments[common]
      ) {
        common++
      }
      if (common > 0 && common === wsSegments.length) {
        p = pSegments.slice(common).join('/')
      }
    }
  }
  while (p.startsWith('./')) {
    p = p.slice(2)
  }
  if (p.startsWith('/')) {
    p = p.slice(1)
  }
  return p
}

/**
 * Normalizes a finding's file path to be repo-relative and recomputes its ID if needed.
 */
export const normalizeFinding = (finding: Finding, workspace?: string): Finding => {
  const normFile = normalizeFindingPath(finding.file, workspace)
  if (normFile === finding.file) {
    return finding
  }
  return {
    ...finding,
    file: normFile,
    id: findingId({
      source: finding.source,
      ruleId: finding.ruleId,
      file: normFile,
      startLine: finding.startLine,
    }),
  }
}

/** Same file + overlapping lines + same CWE (or same rule) → keep highest severity, merge sources in message. */
export const dedupeFindings = (all: Finding[]): Finding[] => {
  const result: Finding[] = []
  for (const finding of all) {
    const matchIndex = result.findIndex(
      (existing) =>
        existing.file === finding.file &&
        Math.max(existing.startLine, finding.startLine) <=
          Math.min(existing.endLine, finding.endLine) &&
        ((existing.cwe && finding.cwe && existing.cwe === finding.cwe) ||
          existing.ruleId === finding.ruleId)
    )

    if (matchIndex === -1) {
      result.push({ ...finding })
    } else {
      const existing = result[matchIndex]
      const existingSevIdx = SEVERITY_ORDER.indexOf(existing.severity)
      const findingSevIdx = SEVERITY_ORDER.indexOf(finding.severity)
      const higherFinding = findingSevIdx < existingSevIdx ? finding : existing
      const lowerFinding = findingSevIdx < existingSevIdx ? existing : finding

      let mergedMessage = higherFinding.message
      if (
        existing.source !== finding.source &&
        !mergedMessage.includes(lowerFinding.source)
      ) {
        mergedMessage = `${mergedMessage} (also reported by ${lowerFinding.source})`
      }

      result[matchIndex] = {
        ...higherFinding,
        startLine: Math.min(existing.startLine, finding.startLine),
        endLine: Math.max(existing.endLine, finding.endLine),
        message: mergedMessage,
        cwe: higherFinding.cwe ?? lowerFinding.cwe,
        symbol: higherFinding.symbol ?? lowerFinding.symbol,
        fix: higherFinding.fix ?? lowerFinding.fix,
      }
    }
  }
  return result
}

/** Keep only findings that intersect the changed line ranges of the diff. */
export const onlyChanged = (
  all: Finding[],
  changed: Map<string, LineRange[]>
): Finding[] => {
  return all.filter((finding) => {
    const ranges = changed.get(finding.file)
    if (!ranges) return false
    return ranges.some(
      (range) =>
        !range.isPureDeletion &&
        Math.max(finding.startLine, range.start) <= Math.min(finding.endLine, range.end)
    )
  })
}
