import type { AnalyzerReportRow } from '../../common/formatting/summary'
import { resolveSandboxBackend } from '../../sandbox/docker'
import type { RunResult } from '../../sandbox/run'
import type { ReviewConfig } from '../config'
import { dedupeFindings, type Finding } from '../findings'
import { runBandit } from './bandit'
import { runRuff } from './ruff'
import { runTsc } from './typescript'

export type AnalyzerToolName = 'bandit' | 'ruff' | 'tsc'

export interface StaticAnalysisResult {
  findings: Finding[]
  runs: RunResult[]
  reports: AnalyzerReportRow[]
}

/**
 * Runs static analyzers against changed files with timeout isolation and deduplication.
 * Uses Promise.allSettled and never throws.
 */
export const runStaticAnalysis = async (
  cfg: ReviewConfig,
  files: string[],
  requestedTools?: AnalyzerToolName[]
): Promise<StaticAnalysisResult> => {
  const runs: RunResult[] = []
  const allFindings: Finding[] = []
  const reports: AnalyzerReportRow[] = []

  if (!cfg.staticAnalysis || files.length === 0) {
    return { findings: [], runs: [], reports: [] }
  }

  try {
    const backend = await resolveSandboxBackend(cfg.sandbox)

    const pyFiles = files.filter((f) => f.endsWith('.py'))
    const tsFiles = files.filter(
      (f) =>
        f.endsWith('.ts') ||
        f.endsWith('.tsx') ||
        f.endsWith('.mts') ||
        f.endsWith('.cts')
    )

    const shouldRun = (tool: AnalyzerToolName) =>
      !requestedTools || requestedTools.includes(tool)

    const tasks: Promise<{
      tool: AnalyzerToolName
      backend: string
      findings: Finding[]
      runResult?: RunResult
    }>[] = []

    if (shouldRun('bandit') && pyFiles.length > 0) {
      tasks.push(
        runBandit(pyFiles, cfg.workspace, backend, cfg.analyzerTimeoutMs)
          .then((res) => ({
            tool: 'bandit' as const,
            backend,
            findings: res.findings,
            runResult: res.runResult,
          }))
          .catch((err) => ({
            tool: 'bandit' as const,
            backend,
            findings: [],
            runResult: {
              status: 'error' as const,
              exitCode: null,
              stderr: String(err),
              durationMs: 0,
            },
          }))
      )
    }

    if (shouldRun('ruff') && pyFiles.length > 0) {
      tasks.push(
        runRuff(pyFiles, cfg.workspace, backend, cfg.analyzerTimeoutMs)
          .then((res) => ({
            tool: 'ruff' as const,
            backend,
            findings: res.findings,
            runResult: res.runResult,
          }))
          .catch((err) => ({
            tool: 'ruff' as const,
            backend,
            findings: [],
            runResult: {
              status: 'error' as const,
              exitCode: null,
              stderr: String(err),
              durationMs: 0,
            },
          }))
      )
    }

    if (shouldRun('tsc') && tsFiles.length > 0) {
      tasks.push(
        runTsc(tsFiles, cfg.workspace, cfg.analyzerTimeoutMs)
          .then((res) => ({
            tool: 'tsc' as const,
            backend: 'host',
            findings: res.findings,
            runResult: res.runResult,
          }))
          .catch((err) => ({
            tool: 'tsc' as const,
            backend: 'host',
            findings: [],
            runResult: {
              status: 'error' as const,
              exitCode: null,
              stderr: String(err),
              durationMs: 0,
            },
          }))
      )
    }

    const settled = await Promise.allSettled(tasks)

    for (const res of settled) {
      if (res.status === 'fulfilled') {
        const val = res.value
        allFindings.push(...val.findings)
        if (val.runResult) {
          runs.push({ ...val.runResult, tool: val.tool })
          reports.push({
            tool: val.tool,
            backend: val.backend,
            status: val.runResult.status,
            findings: val.findings.length,
            durationMs: 'durationMs' in val.runResult ? val.runResult.durationMs : 0,
          })
        }
      }
    }
  } catch (err) {
    console.warn('[CodeSentinel] Static analysis error:', err)
  }

  return {
    findings: dedupeFindings(allFindings),
    runs,
    reports,
  }
}
