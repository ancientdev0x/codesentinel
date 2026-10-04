import { createReporter } from '../../github/reporter'
import { dedupeFindings } from '../../review/findings'
import type { ReviewStateType, ReviewStateUpdate } from '../state'

export interface ReportDeps {
  createReporter?: typeof createReporter
}

export const report = (deps: ReportDeps = {}) => {
  const doCreateReporter = deps.createReporter ?? createReporter

  return async (state: ReviewStateType): Promise<ReviewStateUpdate> => {
    const attempts = {
      ...state.attempts,
      report: (state.attempts?.report ?? 0) + 1,
    }

    const reporter = doCreateReporter(state.cfg)

    // Gather confirmed findings: confirmed static findings + valid LLM findings
    const confirmedStatic = state.staticFindings.filter((f) => f.status === 'confirmed')
    const allFindings = dedupeFindings([...confirmedStatic, ...state.llmFindings])

    // Post inline review comments for all confirmed findings
    for (const finding of allFindings) {
      let body = `**[${finding.severity.toUpperCase()}]** ${finding.message}`
      if (finding.cwe) {
        body += ` (${finding.cwe})`
      }
      if (finding.rationale) {
        body += `\n\n*Rationale:* ${finding.rationale}`
      }
      if (finding.fix) {
        body += `\n\n\`\`\`suggestion\n${finding.fix.replacement}\n\`\`\``
      }

      await reporter
        .postReviewComment({
          filePath: finding.file,
          comment: body,
          startLine: finding.startLine,
          endLine: finding.endLine,
        })
        .catch((err) => {
          console.warn(
            `[CodeSentinel] Failed to post comment on ${finding.file}:${finding.startLine}:`,
            err
          )
        })
    }

    // Build final summary
    let summaryText = state.summary.trim()
    if (!summaryText) {
      summaryText = `CodeSentinel reviewed ${state.files.length} changed files and recorded ${allFindings.length} findings.`
    }

    if (state.degraded.length > 0) {
      summaryText += `\n\n> ⚠️ **Degraded components / tools**: ${state.degraded.join(', ')}`
    }

    await reporter.postSummary(summaryText).catch((err) => {
      console.warn('[CodeSentinel] Failed to post review summary:', err)
    })

    return {
      summary: summaryText,
      attempts,
    }
  }
}
