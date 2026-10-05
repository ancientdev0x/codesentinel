import { createReporter } from '../../github/reporter'
import { dedupeFindings, normalizeFinding } from '../../review/findings'
import { getRejectedIds } from '../../review/patch-commands'
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

    const rejectedIds = state.cfg?.workspace
      ? await getRejectedIds(state.cfg.workspace)
      : new Set<string>()

    const isLlmTriageDegraded = state.degraded.includes('llm_triage')

    const SEVERITY_RANK: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
      info: 0,
    }

    // Gather confirmed findings: confirmed static findings + valid LLM findings (skipping rejected)
    const confirmedStatic = state.staticFindings.filter(
      (f) => f.status === 'confirmed' && !rejectedIds.has(f.id)
    )
    const validLlm = (state.llmFindings ?? []).filter((f) => !rejectedIds.has(f.id))

    // When LLM triage is degraded, report deterministic analyzer findings directly
    const unconfirmedStatic = isLlmTriageDegraded
      ? state.staticFindings.filter((f) => !rejectedIds.has(f.id))
      : []

    const allFindings = dedupeFindings([
      ...confirmedStatic,
      ...validLlm,
      ...unconfirmedStatic,
    ]).map((f) => normalizeFinding(f, state.cfg?.workspace))

    // Post inline review comments for all reportable findings
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
        const patch = state.patches?.find(
          (p) => p.id === finding.id || p.file === finding.file
        )
        if (patch) {
          const headSha = state.cfg?.headSha ?? ''
          const traceId =
            process.env.CodeSentinel_RUN_ID || process.env.CODESENTINEL_RUN_ID || ''
          const marker = `<!-- codesentinel:patch id=${patch.id} finding=${finding.id} sha=${headSha}${traceId ? ` trace=${traceId}` : ''} -->`
          body += `\n\n<details><summary>Patch ${patch.id} · +${patch.stats.added} −${patch.stats.removed}</summary>\n\n\`\`\`diff\n${patch.diff}\n\`\`\`\n\n${marker}\n</details>`
          body += `\n\nReply \`/codesentinel apply ${patch.id}\` or \`/codesentinel reject ${patch.id}\`.`
        }
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
    let summaryText = ''
    if (isLlmTriageDegraded) {
      summaryText =
        'LLM triage unavailable — showing deterministic analyzer findings only.'
      // Gather deterministic findings sorted by severity descending
      const sortedDeterministic = [...state.staticFindings]
        .filter((f) => !rejectedIds.has(f.id))
        .sort(
          (a, b) =>
            (SEVERITY_RANK[b.severity?.toLowerCase()] ?? 0) -
            (SEVERITY_RANK[a.severity?.toLowerCase()] ?? 0)
        )
      const top20 = dedupeFindings(sortedDeterministic).slice(0, 20)
      if (top20.length > 0) {
        const header =
          '| File:Line | Rule | Severity | Message |\n| --- | --- | --- | --- |'
        const rows = top20.map((f) => {
          const loc = `${f.file}:${f.startLine ?? 0}`
          const sev = (f.severity || 'medium').toUpperCase()
          const rule = f.ruleId || f.cwe || f.source
          const cleanMsg = f.message.replace(/\|/g, '\\|').replace(/\n/g, ' ')
          return `| ${loc} | ${rule} | ${sev} | ${cleanMsg} |`
        })
        summaryText += `\n\n### Deterministic Analyzer Findings (Top ${top20.length})\n\n${header}\n${rows.join('\n')}`
      }
    } else {
      summaryText = state.summary.trim()
      if (!summaryText) {
        summaryText = 'CodeSentinel completed the review; see the inline comments.'
      }
    }

    if (state.degraded.length > 0) {
      summaryText += `\n\n> ⚠️ **Degraded components / tools**: ${state.degraded.join(', ')}`
    }

    const hasRows = state.analyzerReports && state.analyzerReports.length > 0
    const summaryUrl = hasRows
      ? await reporter.postSummary(summaryText, state.analyzerReports).catch((err) => {
          console.warn('[CodeSentinel] Failed to post review summary:', err)
          return undefined
        })
      : await reporter.postSummary(summaryText).catch((err) => {
          console.warn('[CodeSentinel] Failed to post review summary:', err)
          return undefined
        })

    return {
      summary: summaryText,
      summaryUrl: summaryUrl ?? null,
      attempts,
    }
  }
}
