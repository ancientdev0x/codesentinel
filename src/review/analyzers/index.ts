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

  if (!cfg.staticAnalysis || files.length === 0) {
    return { findings: [], runs: [] }
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

    const tasks: Promise<{ findings: Finding[]; runResult?: RunResult }>[] = []

    if (shouldRun('bandit') && pyFiles.length > 0) {
      tasks.push(
        runBandit(pyFiles, cfg.workspace, backend, cfg.analyzerTimeoutMs).catch(
          (err) => ({
            findings: [],
            runResult: {
              status: 'error' as const,
              exitCode: null,
              stderr: String(err),
              durationMs: 0,
            },
          })
        )
      )
    }

    if (shouldRun('ruff') && pyFiles.length > 0) {
      tasks.push(
        runRuff(pyFiles, cfg.workspace, backend, cfg.analyzerTimeoutMs).catch((err) => ({
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
        runTsc(tsFiles, cfg.workspace, cfg.analyzerTimeoutMs).catch((err) => ({
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
        allFindings.push(...res.value.findings)
        if (res.value.runResult) {
          runs.push(res.value.runResult)
        }
      }
    }
  } catch (err) {
    console.warn('[CodeSentinel] Static analysis error:', err)
  }

  return {
    findings: dedupeFindings(allFindings),
    runs,
  }
}
