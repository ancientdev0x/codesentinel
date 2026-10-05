import { findingId, type Finding, type Severity } from '../review/findings'

export interface RecordFindingParams {
  file: string
  startLine: number
  endLine: number
  severity: Severity
  message: string
  cwe?: string
  fix?: { replacement: string; startLine: number; endLine: number }
}

export interface TriageDecision {
  decision: 'confirm' | 'dismiss'
  rationale: string
  fix?: { replacement: string; startLine: number; endLine: number }
}

export class Collector {
  private findings: Finding[] = []
  private triageMap = new Map<string, TriageDecision>()

  recordFinding(params: RecordFindingParams): string {
    const id = findingId({
      source: 'llm',
      ruleId: params.cwe ?? 'llm-finding',
      file: params.file,
      startLine: params.startLine,
    })

    const finding: Finding = {
      id,
      source: 'llm',
      ruleId: params.cwe ?? 'llm-finding',
      severity: params.severity,
      file: params.file,
      startLine: params.startLine,
      endLine: params.endLine,
      message: params.message,
      cwe: params.cwe,
      status: 'confirmed',
      fix: params.fix,
    }

    this.findings.push(finding)
    return id
  }

  triageFinding(
    id: string,
    decision: 'confirm' | 'dismiss',
    rationale: string,
    fix?: { replacement: string; startLine: number; endLine: number }
  ): void {
    this.triageMap.set(id, { decision, rationale, fix })
  }

  getFindings(): Finding[] {
    return [...this.findings]
  }

  getTriageDecisions(): Map<string, TriageDecision> {
    return new Map(this.triageMap)
  }

  clear(): void {
    this.findings = []
    this.triageMap.clear()
  }
}

/**
 * Module-level collector map keyed by CodeSentinel_RUN_ID.
 * The flue agent initializer only receives process.env/context, so the workflow
 * binds this map entry before session creation and clears it when finished.
 */
const collectors = new Map<string, Collector>()

export const getOrCreateCollector = (runId: string): Collector => {
  let collector = collectors.get(runId)
  if (!collector) {
    collector = new Collector()
    collectors.set(runId, collector)
  }
  return collector
}

export const getCollector = (runId: string): Collector | undefined => {
  return collectors.get(runId)
}

export const deleteCollector = (runId: string): void => {
  collectors.delete(runId)
}
