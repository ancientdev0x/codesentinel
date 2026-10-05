import { describe, expect, it } from 'vitest'
import {
  type AnalyzerReportRow,
  formatAnalyzerReport,
  formatSummary,
} from '../../../src/common/formatting/summary'

describe('formatAnalyzerReport and formatSummary', () => {
  it('formats empty analyzer rows as empty string', () => {
    expect(formatAnalyzerReport([])).toBe('')
  })

  it('formats analyzer rows into a markdown table', () => {
    const rows: AnalyzerReportRow[] = [
      {
        tool: 'bandit',
        backend: 'docker',
        status: 'ok',
        findings: 2,
        durationMs: 1500,
        confirmed: 2,
        dismissed: 0,
      },
      {
        tool: 'ruff',
        backend: 'docker',
        status: 'ok',
        findings: 3,
        durationMs: 400,
      },
      {
        tool: 'tsc',
        backend: 'host',
        status: 'ok',
        findings: 1,
        durationMs: 2200,
        confirmed: 1,
      },
    ]

    const table = formatAnalyzerReport(rows)
    expect(table).toContain('### Analyzer Report')
    expect(table).toContain(
      '| Tool | Backend | Status | Findings | Duration | Confirmed | Dismissed |'
    )
    expect(table).toContain('| bandit | docker | ok | 2 | 1.5s | 2 | 0 |')
    expect(table).toContain('| ruff | docker | ok | 3 | 0.4s | - | - |')
    expect(table).toContain('| tsc | host | ok | 1 | 2.2s | 1 | - |')
  })

  it('includes the analyzer report table in formatSummary when provided', () => {
    const rows: AnalyzerReportRow[] = [
      {
        tool: 'bandit',
        backend: 'docker',
        status: 'ok',
        findings: 1,
        durationMs: 1200,
      },
    ]

    const summary = formatSummary('Found a security issue.', rows)
    expect(summary).toContain('Found a security issue.')
    expect(summary).toContain('### Analyzer Report')
    expect(summary).toContain('| bandit | docker | ok | 1 | 1.2s | - | - |')
  })

  it('omits the analyzer report table in formatSummary when rows are omitted or empty', () => {
    const summaryWithout = formatSummary('LGTM')
    expect(summaryWithout).not.toContain('### Analyzer Report')

    const summaryEmpty = formatSummary('LGTM', [])
    expect(summaryEmpty).not.toContain('### Analyzer Report')
  })

  it('uses clean CodeSentinel Review header and single plain signoff without sponsor branding', () => {
    const summary = formatSummary('Looks good.')
    expect(summary).toContain('## CodeSentinel Review')
    expect(summary).toContain(
      'Review by [CodeSentinel](https://github.com/ancientdev0x/CodeSentinel)'
    )
    expect(summary).not.toContain('General Summary')
    expect(summary).not.toContain('🏴‍☠️')
    expect(summary).not.toContain('YOUR COMPANY HERE')
    expect(summary).not.toContain('sustain.dev')
    expect(summary).not.toContain('<details>')
  })
})
