import * as v from 'valibot'
import { FindingSchema, type Finding } from '../../review/findings'
import type { ReviewStateType, ReviewStateUpdate, StageError } from '../state'

export const validateFindingIntersectsDiff = (
  finding: Finding,
  changedLines: Array<{ start: number; end: number }>
): boolean => {
  return changedLines.some(
    (range) => finding.startLine <= range.end && finding.endLine >= range.start
  )
}

export const validate = () => {
  return async (state: ReviewStateType): Promise<ReviewStateUpdate> => {
    const attempts = {
      ...state.attempts,
      validate: (state.attempts?.validate ?? 0) + 1,
    }

    const errors: StageError[] = []
    const validLlmFindings: Finding[] = []
    const fileMap = new Map(state.files.map((f) => [f.fileName, f]))

    // 1 & 2 & 3: Validate LLM-produced findings
    for (const finding of state.llmFindings) {
      const parsed = v.safeParse(FindingSchema, finding)
      if (!parsed.success) {
        errors.push({
          stage: 'validate',
          kind: 'invalid_output',
          findingId: finding.id,
          detail: `Finding schema validation failed: ${parsed.issues.map((i) => i.message).join('; ')}`,
        })
        continue
      }

      const fileObj = fileMap.get(finding.file)
      if (!fileObj) {
        errors.push({
          stage: 'validate',
          kind: 'invalid_output',
          findingId: finding.id,
          detail: `Finding targets file "${finding.file}" which is not in the changed files list`,
        })
        continue
      }

      if (!validateFindingIntersectsDiff(finding, fileObj.changedLines)) {
        errors.push({
          stage: 'validate',
          kind: 'out_of_diff',
          findingId: finding.id,
          detail: `Finding targets L${finding.startLine}..L${finding.endLine} in "${finding.file}", but changed lines are ${fileObj.changedLines.map((l) => `${l.start}-${l.end}`).join(', ')}`,
        })
        continue
      }

      if (finding.fix) {
        if (finding.fix.startLine > finding.fix.endLine || finding.fix.startLine < 1) {
          errors.push({
            stage: 'validate',
            kind: 'bad_patch',
            findingId: finding.id,
            detail: `Finding fix line range ${finding.fix.startLine}..${finding.fix.endLine} is invalid`,
          })
          continue
        }
      }

      validLlmFindings.push(finding)
    }

    // 4. Pre-detected findings with severity >= medium must be triaged
    const highSeverityLevels = new Set(['critical', 'high', 'medium'])
    for (const finding of state.staticFindings) {
      if (highSeverityLevels.has(finding.severity)) {
        if (finding.status === 'candidate') {
          errors.push({
            stage: 'validate',
            kind: 'invalid_output',
            findingId: finding.id,
            detail: `Pre-detected ${finding.severity} finding ${finding.id} (${finding.ruleId} in ${finding.file}:L${finding.startLine}) was not triaged with triage_finding`,
          })
        }
      }
    }

    // 6. Summary check
    if (!state.summary || state.summary.trim().length === 0) {
      errors.push({
        stage: 'validate',
        kind: 'empty_review',
        detail: 'Review summary is empty; an ending summary text is required',
      })
    }

    return {
      llmFindings: validLlmFindings,
      errors,
      attempts,
    }
  }
}
