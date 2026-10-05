import { randomUUID } from 'node:crypto'
import { type JsonValue, type WorkflowRouteHandler, defineWorkflow } from '@flue/runtime'
import { Command } from '@langchain/langgraph'
import * as v from 'valibot'
import reviewer from '../agents/reviewer'
import { sendReviewStarted } from '../common/telemetry'
import { deleteCollector } from '../graph/collector'
import { buildReviewGraph } from '../graph/review-graph'
import type { StageError } from '../graph/state'
import { flushTracing, initTracing } from '../observability/langfuse'
import type { PromptableSession } from '../observability/tokens'
import { type ReviewPayload, resolveReviewConfig } from '../review/config'
import { dedupeFindings } from '../review/findings'

/**
 * Permissive top-level object schema for workflow run payload.
 * Valibot's object() ignores unknown keys, so old callers keep working.
 */
export const ReviewWorkflowInputSchema = v.object({
  platform: v.optional(v.picklist(['github', 'local'])),
  workspace: v.optional(v.string()),
  prUrl: v.optional(v.string()),
  baseSha: v.optional(v.string()),
  headSha: v.optional(v.string()),
  model: v.optional(v.string()),
  thinkingLevel: v.optional(v.picklist(['off', 'low', 'medium', 'high'])),
  reviewLanguage: v.optional(v.string()),
  ignore: v.optional(v.array(v.string())),
  customInstructions: v.optional(v.string()),
  telemetry: v.optional(v.boolean()),
  owner: v.optional(v.string()),
  repo: v.optional(v.string()),
  prNumber: v.optional(v.number()),
  mcpServers: v.optional(v.record(v.string(), v.any())),
  staticAnalysis: v.optional(v.boolean()),
  sandbox: v.optional(v.picklist(['docker', 'host', 'auto'])),
  analyzerTimeoutMs: v.optional(v.number()),
  astChecks: v.optional(v.boolean()),
  hitlMode: v.optional(v.picklist(['off', 'suggest', 'interactive'])),
  maxAttempts: v.optional(v.number()),
  resume: v.optional(
    v.object({
      threadId: v.string(),
      decisions: v.record(v.string(), v.any()),
    })
  ),
})

/**
 * Opt the workflow into HTTP transport — `POST /workflows/review` on the built server.
 * beta.9 only exposes a discovered workflow over HTTP when it exports a `route`
 * middleware (otherwise it is dispatch-only); this pass-through is enough.
 */
export const route: WorkflowRouteHandler = async (_c, next) => next()

export default defineWorkflow({
  agent: reviewer,
  input: ReviewWorkflowInputSchema,
  async run(ctx): Promise<JsonValue> {
    initTracing(process.env)
    const { harness } = ctx
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const input = (ctx.input ?? (ctx as { payload?: any }).payload) as
      | (ReviewPayload & {
          resume?: {
            threadId: string
            decisions: Record<string, any>
          }
        })
      | undefined

    if (input?.resume) {
      const { threadId, decisions } = input.resume
      process.env.CodeSentinel_RUN_ID = threadId
      process.env.CODESENTINEL_RUN_ID = threadId

      try {
        let sessionInstance: PromptableSession | undefined
        const graph = buildReviewGraph({
          llmTriage: {
            sessionFactory: async () => {
              if (!sessionInstance) {
                sessionInstance = await harness.session()
              }
              return sessionInstance
            },
          },
        })

        const resumeCommand = new Command({ resume: decisions })
        const resumedState: any = await graph.invoke(resumeCommand as any, {
          configurable: { thread_id: threadId },
          recursionLimit: 25,
        })

        if (resumedState.__interrupt__ && resumedState.__interrupt__.length > 0) {
          const payload = resumedState.__interrupt__[0].value
          return {
            status: 'awaiting_approval',
            threadId,
            patches: payload.patches ?? [],
            error: payload.error,
          } as unknown as JsonValue
        }

        const confirmedFindings = [
          ...resumedState.staticFindings.filter((f: any) => f.status === 'confirmed'),
          ...resumedState.llmFindings,
        ]
        const findings = dedupeFindings(confirmedFindings)

        return {
          status: 'completed',
          reviewed: resumedState.files?.length ?? 0,
          summaryPosted: Boolean(resumedState.summaryUrl),
          summaryUrl: resumedState.summaryUrl ?? null,
          summary: resumedState.summary ?? '',
          applied: resumedState.applied ?? [],
          findings,
          degraded: resumedState.degraded ?? [],
          attempts: resumedState.attempts ?? {},
        } as unknown as JsonValue
      } finally {
        deleteCollector(threadId)
        await flushTracing().catch((err) => {
          console.warn('[CodeSentinel] Failed to flush Langfuse tracing:', err)
        })
      }
    }

    const cfg = resolveReviewConfig(input, process.env)
    if (input?.platform) {
      process.env.CodeSentinel_INPUT_PLATFORM = input.platform
    } else {
      delete process.env.CodeSentinel_INPUT_PLATFORM
    }
    const runId = randomUUID()
    process.env.CodeSentinel_RUN_ID = runId
    process.env.CODESENTINEL_RUN_ID = runId

    let cleanupPr: (() => Promise<void>) | undefined
    try {
      let sessionInstance: PromptableSession | undefined
      const graph = buildReviewGraph({
        ingest: {
          onCleanupPr: (cleanup) => {
            cleanupPr = cleanup
          },
        },
        llmTriage: {
          sessionFactory: async () => {
            if (!sessionInstance) {
              sessionInstance = await harness.session()
            }
            return sessionInstance
          },
        },
      })

      const finalState: any = await graph.invoke(
        { cfg },
        {
          configurable: { thread_id: runId },
          recursionLimit: 25,
        }
      )

      if (finalState.__interrupt__ && finalState.__interrupt__.length > 0) {
        const payload = finalState.__interrupt__[0].value
        return {
          status: 'awaiting_approval',
          threadId: runId,
          patches: payload.patches ?? [],
          error: payload.error,
        } as unknown as JsonValue
      }

      if (finalState.files.length === 0) {
        return {
          reviewed: 0,
          summaryPosted: false,
          message: 'No changed files to review.',
        }
      }

      sendReviewStarted(
        {
          enabled: cfg.telemetry,
          repoSeed: cfg.github ? `${cfg.github.owner}/${cfg.github.repo}` : cfg.workspace,
          platform: cfg.platform,
          model: cfg.model,
        },
        finalState.files.length
      )

      const crashError = finalState.errors?.find(
        (e: StageError) => e.stage === 'llm_triage' && e.kind === 'crash'
      )
      if (crashError) {
        throw new Error(crashError.detail)
      }

      const confirmedFindings = [
        ...finalState.staticFindings.filter((f: any) => f.status === 'confirmed'),
        ...finalState.llmFindings,
      ]
      const findings = dedupeFindings(confirmedFindings)

      return {
        reviewed: finalState.files.length,
        summaryPosted: Boolean(finalState.summaryUrl),
        summaryUrl: finalState.summaryUrl ?? null,
        summary: finalState.summary,
        findings,
        degraded: finalState.degraded,
        attempts: finalState.attempts,
      } as unknown as JsonValue
    } finally {
      deleteCollector(runId)
      await flushTracing().catch((err) => {
        console.warn('[CodeSentinel] Failed to flush Langfuse tracing:', err)
      })
      if (cleanupPr) {
        await cleanupPr().catch((err) => {
          console.warn(
            '[CodeSentinel] Failed to clean up materialized PR directory:',
            err
          )
        })
      }
    }
  },
})
