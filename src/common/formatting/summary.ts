/**
 * Constants for formatting comments
 */
export const FORMATTING = {
  SUMMARY_TITLE: '## General Summary 🏴‍☠️',
  SEPARATOR: '\n\n---\n\n',
  SIGN_OFF:
    '### Review powered by [CodeSentinel 🚢](https://github.com/ancientdev0x/CodeSentinel)',
  CTA: `<details>
<summary>🚀 Good review?</summary>

---

**Help us improve!** Your feedback and support make CodeSentinel better for everyone.

⭐ **Quick win?** [Star the repo](https://github.com/ancientdev0x/CodeSentinel) if you find it useful  
💡 **Have ideas?** [Open a discussion](https://github.com/ancientdev0x/CodeSentinel/discussions)
🛠️ **Wanna chat about agents?** [Send me a DM](https://x.com/ancientdev0x)


---

*Sponsor the project* to preview features and influence the roadmap

👉 [YOUR COMPANY HERE](https://sustain.dev/sponsor/CodeSentinel) 👈

</details>`,
  TOOL_CALLS_TITLE: '🛠️ Tool Calls',
  TOKEN_USAGE_TITLE: '📊 Token Usage',
  ANALYZER_REPORT_TITLE: '### Analyzer Report',
}

export interface AnalyzerReportRow {
  tool: string
  backend: string
  status: string
  findings: number
  durationMs: number
  confirmed?: number
  dismissed?: number
}

/**
 * Formats an Analyzer Report markdown table
 */
export const formatAnalyzerReport = (rows: AnalyzerReportRow[]): string => {
  if (rows.length === 0) return ''

  const header =
    '| Tool | Backend | Status | Findings | Duration | Confirmed | Dismissed |\n| --- | --- | --- | --- | --- | --- | --- |'
  const lines = rows.map((r) => {
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`
    const conf = r.confirmed !== undefined ? String(r.confirmed) : '-'
    const dis = r.dismissed !== undefined ? String(r.dismissed) : '-'
    return `| ${r.tool} | ${r.backend} | ${r.status} | ${r.findings} | ${dur} | ${conf} | ${dis} |`
  })

  return `${FORMATTING.ANALYZER_REPORT_TITLE}\n\n${header}\n${lines.join('\n')}`
}

/**
 * Formats a thread comment with title, content, optional analyzer report, and sign-off
 */
export const formatSummary = (
  comment: string,
  analyzerRows?: AnalyzerReportRow[]
): string => {
  const analyzerTable =
    analyzerRows && analyzerRows.length > 0
      ? `\n\n${formatAnalyzerReport(analyzerRows)}`
      : ''
  return `${FORMATTING.SUMMARY_TITLE}\n\n${comment}${analyzerTable}${FORMATTING.SEPARATOR}${FORMATTING.SIGN_OFF}\n\n${FORMATTING.CTA}`
}
