import { type AnalyzerToolName, runStaticAnalysis } from '../../review/analyzers'
import type { ReviewConfig } from '../../review/config'
import { getRejectedIds } from '../../review/patch-commands'
import type { ReviewStateType, ReviewStateUpdate, StageError } from '../state'

export interface StaticAnalysisDeps {
  runStaticAnalysis?: typeof runStaticAnalysis
}

export const staticAnalysis = (deps: StaticAnalysisDeps = {}) => {
  const doRunStaticAnalysis = deps.runStaticAnalysis ?? runStaticAnalysis

  return async (state: ReviewStateType): Promise<ReviewStateUpdate> => {
    const attempts = {
      ...state.attempts,
      static_analysis: (state.attempts?.static_analysis ?? 0) + 1,
    }

    try {
      if (!state.cfg.staticAnalysis || state.files.length === 0) {
        return {
          attempts,
        }
      }

      // Merge state.cfg with recovery.adjust
      const adjustedCfg: ReviewConfig = {
        ...state.cfg,
        analyzerTimeoutMs:
          state.recovery?.adjust?.timeoutMs ?? state.cfg.analyzerTimeoutMs,
        sandbox: state.recovery?.adjust?.backend ?? state.cfg.sandbox,
      }

      const skipTools = new Set(state.recovery?.adjust?.skipTools ?? [])
      const hasRestrictions = skipTools.size > 0 || state.degraded.length > 0
      const requestedTools = hasRestrictions
        ? (['bandit', 'ruff', 'tsc'] as AnalyzerToolName[]).filter(
            (t) => !skipTools.has(t) && !state.degraded.includes(t)
          )
        : undefined

      const filePaths = state.files.map((f) => f.fileName)
      const result = requestedTools
        ? await doRunStaticAnalysis(adjustedCfg, filePaths, requestedTools)
        : await doRunStaticAnalysis(adjustedCfg, filePaths)

      const errors: StageError[] = []
      for (const run of result.runs) {
        if (run.status === 'timeout') {
          const timeout = adjustedCfg.analyzerTimeoutMs ?? 5000
          errors.push({
            stage: 'static_analysis',
            kind: 'timeout',
            tool: (run as { tool?: string }).tool,
            detail: `Analyzer ${(run as { tool?: string }).tool ?? 'tool'} timed out after ${timeout}ms`,
          })
        } else if (run.status === 'error') {
          const isDocker =
            adjustedCfg.sandbox === 'docker' ||
            (run as { stderr?: string }).stderr?.toLowerCase().includes('docker')
          errors.push({
            stage: 'static_analysis',
            kind: isDocker ? 'unavailable' : 'crash',
            tool: (run as { tool?: string }).tool,
            detail:
              (run as { stderr?: string }).stderr ||
              `Analyzer ${(run as { tool?: string }).tool ?? 'tool'} failed with status error`,
          })
        }
      }

      const rejectedIds = state.cfg.workspace
        ? await getRejectedIds(state.cfg.workspace)
        : new Set<string>()
      const nonRejected = (result.findings ?? []).filter((f) => !rejectedIds.has(f.id))

      return {
        staticFindings: [...(state.staticFindings ?? []), ...nonRejected],
        analyzerReports: [...(state.analyzerReports ?? []), ...(result.reports ?? [])],
        errors,
        attempts,
      }
    } catch (err) {
      const error: StageError = {
        stage: 'static_analysis',
        kind: 'crash',
        detail: err instanceof Error ? err.message : String(err),
      }
      return {
        errors: [error],
        attempts,
      }
    }
  }
}
