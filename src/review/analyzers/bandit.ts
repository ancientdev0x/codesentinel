import { relative } from 'node:path'
import { type Finding, findingId, type Severity } from '../findings'
import type { RunResult, RunSpec } from '../../sandbox/run'
import { runIsolated } from '../../sandbox/run'

export interface BanditIssue {
  test_id: string
  test_name: string
  issue_severity: string
  issue_confidence: string
  issue_text: string
  line_number: number
  line_range: number[]
  filename: string
  issue_cwe?: {
    id: number
    link: string
  }
}

export interface BanditOutput {
  errors?: unknown[]
  results?: BanditIssue[]
}

const CRITICAL_RULES = new Set([
  'B602', // subprocess_popen_with_shell_equals_true
  'B608', // hardcoded_sql_expressions
  'B301', // pickle
  'B102', // exec_used
  'B506', // yaml_load
  'B605', // start_process_with_a_shell
  'B607', // start_process_with_partial_path
])

export const mapBanditSeverity = (
  testId: string,
  issueSeverity: string,
  issueConfidence: string
): Severity => {
  const sev = issueSeverity.toUpperCase()
  const conf = issueConfidence.toUpperCase()

  if (sev === 'HIGH') {
    if (CRITICAL_RULES.has(testId)) {
      return 'critical'
    }
    return conf === 'HIGH' ? 'high' : 'medium'
  }

  if (sev === 'MEDIUM') {
    return 'medium'
  }

  return 'low'
}

/**
 * Normalizes container paths (/src/...) and absolute workspace paths to repo-relative paths.
 */
export const normalizeFilePath = (rawPath: string, workspace: string): string => {
  let p = rawPath.trim()
  if (p.startsWith('/src/')) {
    p = p.slice('/src/'.length)
  } else if (p.startsWith('/src')) {
    p = p.slice('/src'.length)
  }
  if (p.startsWith('./')) {
    p = p.slice(2)
  }
  if (p.startsWith(workspace)) {
    p = relative(workspace, p)
  }
  return p
}

export const parseBanditJson = (
  jsonStr: string,
  workspace: string
): { findings: Finding[]; error?: string } => {
  let parsed: BanditOutput
  try {
    parsed = JSON.parse(jsonStr) as BanditOutput
  } catch (err) {
    return { findings: [], error: `Invalid Bandit JSON: ${err}` }
  }

  if (!parsed || !Array.isArray(parsed.results)) {
    return { findings: [] }
  }

  const findings: Finding[] = []
  for (const item of parsed.results) {
    const file = normalizeFilePath(item.filename, workspace)
    const startLine =
      Array.isArray(item.line_range) && item.line_range.length > 0
        ? item.line_range[0]
        : item.line_number
    const endLine =
      Array.isArray(item.line_range) && item.line_range.length > 0
        ? item.line_range[item.line_range.length - 1]
        : item.line_number

    const severity = mapBanditSeverity(
      item.test_id,
      item.issue_severity,
      item.issue_confidence
    )
    const confidence = item.issue_confidence.toLowerCase() as 'high' | 'medium' | 'low'
    const cwe = item.issue_cwe?.id ? `CWE-${item.issue_cwe.id}` : undefined

    const finding: Finding = {
      id: findingId({
        source: 'bandit',
        ruleId: item.test_id,
        file,
        startLine,
      }),
      source: 'bandit',
      ruleId: item.test_id,
      severity,
      confidence,
      file,
      startLine,
      endLine,
      message: item.issue_text,
      cwe,
      status: 'candidate',
    }
    findings.push(finding)
  }

  return { findings }
}

export const runBandit = async (
  files: string[],
  workspace: string,
  backend: 'docker' | 'host',
  timeoutMs = 60_000
): Promise<{ findings: Finding[]; runResult: RunResult }> => {
  if (files.length === 0) {
    return {
      findings: [],
      runResult: { status: 'ok', exitCode: 0, stdout: '', stderr: '', durationMs: 0 },
    }
  }

  // Files relative to workspace / /src
  const targetFiles = files.map((f) => normalizeFilePath(f, workspace))

  const spec: RunSpec = {
    tool: 'bandit',
    cmd: 'bandit',
    args: ['-f', 'json', '-q', '--', ...targetFiles],
    cwd: workspace,
    timeoutMs,
    okExitCodes: [0, 1], // Exit code 1 means issues were found
  }

  const runResult = await runIsolated(spec, backend)

  if (runResult.status !== 'ok') {
    return { findings: [], runResult }
  }

  const { findings } = parseBanditJson(runResult.stdout, workspace)
  return { findings, runResult }
}
