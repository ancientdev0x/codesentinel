import { type Finding, findingId, type Severity } from '../findings'
import type { RunResult, RunSpec } from '../../sandbox/run'
import { runIsolated } from '../../sandbox/run'
import { normalizeFilePath } from './bandit'

export interface RuffEdit {
  content: string
  location: { column: number; row: number }
  end_location: { column: number; row: number }
}

export interface RuffFix {
  applicability: string
  message?: string
  edits: RuffEdit[]
}

export interface RuffIssue {
  code: string
  message: string
  filename: string
  location: { column: number; row: number }
  end_location: { column: number; row: number }
  fix?: RuffFix
  url?: string
}

const CRITICAL_S_RULES = new Set([
  'S602', // subprocess_popen_with_shell_equals_true
  'S608', // hardcoded_sql_expressions
  'S301', // pickle
  'S102', // exec_used
  'S506', // yaml_load
  'S605', // start_process_with_a_shell
  'S607', // start_process_with_partial_path
])

export const S_RULE_CWE: Record<string, string> = {
  S602: 'CWE-78',
  S603: 'CWE-78',
  S604: 'CWE-78',
  S605: 'CWE-78',
  S606: 'CWE-78',
  S607: 'CWE-78',
  S608: 'CWE-89',
  S301: 'CWE-502',
  S102: 'CWE-95',
  S307: 'CWE-78',
  S506: 'CWE-20',
  S105: 'CWE-259',
  S106: 'CWE-259',
  S107: 'CWE-259',
}

export const mapRuffSeverity = (
  code: string
): { severity: Severity; isRegression: boolean } => {
  if (code.startsWith('S')) {
    if (CRITICAL_S_RULES.has(code)) {
      return { severity: 'critical', isRegression: false }
    }
    return { severity: 'high', isRegression: false }
  }

  if (code === 'F821' || code === 'F811' || code.startsWith('E9')) {
    return { severity: 'high', isRegression: true }
  }

  if (code.startsWith('B')) {
    return { severity: 'medium', isRegression: false }
  }

  return { severity: 'medium', isRegression: false }
}

export const parseRuffJson = (
  jsonStr: string,
  workspace: string
): { findings: Finding[]; error?: string } => {
  let parsed: RuffIssue[]
  try {
    parsed = JSON.parse(jsonStr) as RuffIssue[]
  } catch (err) {
    return { findings: [], error: `Invalid Ruff JSON: ${err}` }
  }

  if (!Array.isArray(parsed)) {
    return { findings: [] }
  }

  const findings: Finding[] = []
  for (const item of parsed) {
    const file = normalizeFilePath(item.filename, workspace)
    const startLine = item.location.row
    const endLine = item.end_location.row

    const { severity, isRegression } = mapRuffSeverity(item.code)

    let fix: Finding['fix']
    if (item.fix && Array.isArray(item.fix.edits) && item.fix.edits.length > 0) {
      const edit = item.fix.edits[0]
      fix = {
        replacement: edit.content,
        startLine: edit.location.row,
        endLine: edit.end_location.row,
      }
    }

    const finding: Finding = {
      id: findingId({
        source: 'ruff',
        ruleId: item.code,
        file,
        startLine,
      }),
      source: 'ruff',
      ruleId: item.code,
      severity,
      confidence: 'high',
      file,
      startLine,
      endLine,
      message: isRegression ? `[regression] ${item.message}` : item.message,
      cwe: S_RULE_CWE[item.code],
      rationale: isRegression ? 'regression' : undefined,
      status: 'candidate',
      fix,
    }
    findings.push(finding)
  }

  return { findings }
}

export const runRuff = async (
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

  const targetFiles = files.map((f) => normalizeFilePath(f, workspace))

  const spec: RunSpec = {
    tool: 'ruff',
    cmd: 'ruff',
    args: [
      'check',
      '--output-format',
      'json',
      '--select',
      'S,B,E9,F',
      '--no-cache',
      '--isolated',
      '--',
      ...targetFiles,
    ],
    cwd: workspace,
    timeoutMs,
    okExitCodes: [0, 1], // Exit code 1 means lint findings
  }

  const runResult = await runIsolated(spec, backend)

  if (runResult.status !== 'ok') {
    return { findings: [], runResult }
  }

  const { findings } = parseRuffJson(runResult.stdout, workspace)
  return { findings, runResult }
}
