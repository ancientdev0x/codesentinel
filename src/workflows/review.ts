import { type JsonValue, type WorkflowRouteHandler, defineWorkflow } from '@flue/runtime'
import * as v from 'valibot'
import reviewer from '../agents/reviewer'
import { sendReviewStarted } from '../common/telemetry'
import { createReporter } from '../github/reporter'
import {
  applyPayloadToEnv,
  type ReviewPayload,
  resolveReviewConfig,
} from '../review/config'
import { runAstChecks } from '../review/ast/checks'
import { extractAllFragments } from '../review/ast/fragments'
import { buildReviewPrompt } from '../review/context'
import { type ReviewFileWithDiff, getChangedFiles } from '../review/diff'
import { materializePr, parsePrUrl } from '../review/source'
import { filterFiles } from '../review/utils/filterFiles'

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
})

/**
 * One-shot code review, exposed as `POST /workflows/review` on the built server
 * (`node dist/server.mjs`) and runnable via `flue run review`.
 *
 * flue beta.9 shape: a workflow is `defineWorkflow({ agent, run })`. The run
 * handler computes the PR diff, drives the reviewer agent over the shared harness
 * (it posts inline comments via `suggest_change`), then posts the summary. Config
 * resolves from the payload and environment (the reviewer agent resolves the same way),
 * so the agent and workflow stay in lockstep.
 */

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
    const { harness } = ctx
    const input = (ctx.input ?? (ctx as { payload?: ReviewPayload }).payload) as
      | ReviewPayload
      | undefined
    const cfg = resolveReviewConfig(input, process.env)

    let cleanupPr: (() => Promise<void>) | undefined
    try {
      if (cfg.prUrl) {
        const prRef = parsePrUrl(cfg.prUrl)
        const token = process.env.GITHUB_TOKEN
        const materialized = await materializePr(prRef, token)
        cleanupPr = materialized.cleanup
        cfg.workspace = materialized.workspace
        cfg.baseSha = materialized.baseSha
        cfg.headSha = materialized.headSha
        if (token && input?.platform !== 'local') {
          cfg.github = {
            owner: prRef.owner,
            repo: prRef.repo,
            prNumber: prRef.number,
            token,
          }
          cfg.platform = 'github'
        }
      }
      applyPayloadToEnv(cfg, process.env)

      const { files } = await getChangedFiles(cfg)
      let filtered = filterFiles(files, cfg.ignore, cfg.workspace) as ReviewFileWithDiff[]

      if (filtered.length > 300) {
        console.warn(
          `[CodeSentinel] PR contains ${filtered.length} changed files; capping review at 300 files.`
        )
        filtered = filtered.slice(0, 300)
      }

      if (filtered.length === 0) {
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
        filtered.length
      )

      const session = await harness.session()

      const fragments = cfg.astChecks ? extractAllFragments(filtered) : []
      const findings = cfg.astChecks ? runAstChecks(filtered) : []
      const prompt = buildReviewPrompt(
        {
          files: filtered,
          fragments,
          findings,
          astChecks: cfg.astChecks,
        },
        cfg.workspace
      )
      // Use the agent's final message as the summary rather than a structured
      // `result` schema: response_format/json_schema is not supported by every
      // provider (e.g. Cloudflare Workers AI returns 400), and a free-text final
      // message keeps the workflow model-agnostic.
      const response = await session.prompt(prompt)
      const summary =
        response.text?.trim() ||
        'CodeSentinel completed the review; see the inline comments.'

      const reporter = createReporter(cfg)
      const summaryUrl = await reporter.postSummary(summary)

      return {
        reviewed: filtered.length,
        summaryPosted: Boolean(summaryUrl),
        summaryUrl: summaryUrl ?? null,
        summary,
      }
    } finally {
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
