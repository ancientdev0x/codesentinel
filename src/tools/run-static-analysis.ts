import { resolve } from 'node:path'
import { defineTool } from '@flue/runtime'
import * as v from 'valibot'
import { runStaticAnalysis, type AnalyzerToolName } from '../review/analyzers'
import type { ReviewConfig } from '../review/config'

/**
 * Tool allowing the reviewer agent to run sandboxed static analyzers on demand.
 */
export const createRunStaticAnalysisTool = (cfg: ReviewConfig) =>
  defineTool({
    name: 'run_static_analysis',
    description:
      'Runs sandboxed static analyzers (bandit, ruff, tsc) on specified files within the workspace. Returns detected security findings and regressions.',
    input: v.object({
      paths: v.pipe(
        v.array(v.string()),
        v.description('Array of file paths relative to the workspace root or absolute.')
      ),
      tools: v.optional(
        v.pipe(
          v.array(v.picklist(['bandit', 'ruff', 'tsc'])),
          v.description(
            'Optional list of analyzer tools to run (defaults to all applicable tools).'
          )
        )
      ),
    }),
    run: async ({ input: { paths, tools } }) => {
      const workspaceRoot = resolve(cfg.workspace)

      const validatedPaths: string[] = []
      for (const p of paths) {
        const resolved = resolve(workspaceRoot, p)
        if (!resolved.startsWith(workspaceRoot)) {
          throw new Error(
            `Path ${JSON.stringify(p)} is outside workspace ${workspaceRoot}`
          )
        }
        validatedPaths.push(resolved)
      }

      const { findings, runs } = await runStaticAnalysis(
        cfg,
        validatedPaths,
        tools as AnalyzerToolName[] | undefined
      )

      return JSON.stringify({
        findingsCount: findings.length,
        findings,
        runs: runs.map((r) => ({
          status: r.status,
          durationMs: 'durationMs' in r ? r.durationMs : 0,
        })),
      })
    },
  })
