import { createReporter } from '../../github/reporter'
import { dedupeFindings, normalizeFinding, type Finding } from '../../review/findings'
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

    // Group findings by file and overlapping line ranges to post exactly ONE comment per location
    const findingsByFile = new Map<string, Finding[]>()
    for (const finding of allFindings) {
      const list = findingsByFile.get(finding.file) ?? []
      list.push(finding)
      findingsByFile.set(finding.file, list)
    }

    const findingGroups: Finding[][] = []
    for (const [_file, fileFindings] of findingsByFile) {
      const sorted = [...fileFindings].sort(
        (a, b) => a.startLine - b.startLine || a.endLine - b.endLine
      )
      let currentGroup: Finding[] = []
      let groupEnd = -1

      for (const finding of sorted) {
        if (currentGroup.length === 0) {
          currentGroup = [finding]
          groupEnd = finding.endLine
        } else if (finding.startLine <= groupEnd) {
          currentGroup.push(finding)
          groupEnd = Math.max(groupEnd, finding.endLine)
        } else {
          findingGroups.push(currentGroup)
          currentGroup = [finding]
          groupEnd = finding.endLine
        }
      }
      if (currentGroup.length > 0) {
        findingGroups.push(currentGroup)
      }
    }

    for (const group of findingGroups) {
      // Prefer LLM finding if present, otherwise highest severity
      const llmFinding = group.find((f) => f.source === 'llm')
      const primary =
        llmFinding ??
        [...group].sort(
          (a, b) =>
            (SEVERITY_RANK[b.severity?.toLowerCase()] ?? 0) -
            (SEVERITY_RANK[a.severity?.toLowerCase()] ?? 0)
        )[0]

      let body = `**[${primary.severity.toUpperCase()}]** ${primary.message}`
      if (primary.cwe) {
        body += ` (${primary.cwe})`
      }
      if (primary.rationale) {
        body += `\n\n*Rationale:* ${primary.rationale}`
      }

      // Collect detector sources/rules that found it
      const detectors: string[] = []
      for (const f of group) {
        if (f.source !== 'llm') {
          detectors.push(`${f.source} ${f.ruleId}`)
        }
      }
      const uniqueDetectors = [...new Set(detectors)]
      if (uniqueDetectors.length > 0) {
        const isConfirmed = group.some(
          (f) => f.status === 'confirmed' || f.source === 'llm'
        )
        body += `\n\nDetected by: ${uniqueDetectors.join(', ')}${isConfirmed ? ' · LLM confirmed' : ''}`
      }

      // Include suggestion block ONCE (only if a finding in the group has a valid fix)
      const findingWithFix = group.find((f) => f.fix)
      if (findingWithFix?.fix) {
        body += `\n\n\`\`\`suggestion\n${findingWithFix.fix.replacement}\n\`\`\``
        const patch = state.patches?.find(
          (p) => p.id === findingWithFix.id || p.file === findingWithFix.file
        )
        if (patch) {
          const headSha = state.cfg?.headSha ?? ''
          const traceId =
            process.env.CodeSentinel_RUN_ID || process.env.CODESENTINEL_RUN_ID || ''
          const marker = `<!-- codesentinel:patch id=${patch.id} finding=${findingWithFix.id} sha=${headSha}${traceId ? ` trace=${traceId}` : ''} -->`
          body += `\n\n<details><summary>Patch ${patch.id} · +${patch.stats.added} −${patch.stats.removed}</summary>\n\n\`\`\`diff\n${patch.diff}\n\`\`\`\n\n${marker}\n</details>`
          body += `\n\nReply \`/codesentinel apply ${patch.id}\` or \`/codesentinel reject ${patch.id}\`.`
        }
      }

      const postStartLine = findingWithFix?.fix
        ? findingWithFix.fix.startLine
        : primary.startLine
      const postEndLine = findingWithFix?.fix
        ? findingWithFix.fix.endLine
        : primary.endLine

      await reporter
        .postReviewComment({
          filePath: primary.file,
          comment: body,
          startLine: postStartLine,
          endLine: postEndLine,
        })
        .catch((err) => {
          console.warn(
            `[CodeSentinel] Failed to post comment on ${primary.file}:${primary.startLine}:`,
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

    const analyzerReportsWithTriage = (state.analyzerReports ?? []).map((row) => {
      const toolFindings = state.staticFindings.filter((f) => f.source === row.tool)
      const confirmed = toolFindings.filter((f) => f.status === 'confirmed').length
      const dismissed = toolFindings.filter((f) => f.status === 'dismissed').length
      return {
        ...row,
        confirmed,
        dismissed,
      }
    })

    const hasRows = analyzerReportsWithTriage.length > 0
    const summaryUrl = hasRows
      ? await reporter
          .postSummary(summaryText, analyzerReportsWithTriage)
          .catch((err) => {
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
      analyzerReports: analyzerReportsWithTriage,
      attempts,
    }
  }
}
