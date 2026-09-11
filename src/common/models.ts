/**
 * Centralised model configuration — the SINGLE place model defaults and env-var
 * precedence live. No agent, tool, or workflow hardcodes a model string; every role
 * resolves through here. So `CodeSentinel_MODEL` alone configures the whole system, and
 * each role has exactly one documented override that falls back to the base.
 *
 * Precedence per role (first non-empty value wins):
 *   review + /CodeSentinel mention : CodeSentinel_MODEL                                          → sonnet
 *   qa lead + healer          : CodeSentinel_QA_MODEL        → CodeSentinel_MODEL                 → opus
 *   qa per-flow drivers       : CodeSentinel_QA_DRIVER_MODEL → CodeSentinel_QA_MODEL → CodeSentinel_MODEL → sonnet
 *
 * The `override` argument is the workflow payload's `model` (highest precedence —
 * back-compat with `flue run <wf> --payload '{"model":"..."}'`).
 */
type Env = Record<string, string | undefined>

/** General / cost-tier default: review, the QA per-flow drivers, and the mention agent. */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6'
/** Judgment-tier default: the QA lead + healer (exploration, root-cause, source fixes). */
export const DEFAULT_QA_LEAD_MODEL = 'anthropic/claude-opus-4-8'

/** First value that is neither undefined nor empty (env vars are often set to ""). */
const firstSet = (...vals: (string | undefined)[]): string | undefined =>
  vals.find((v) => v !== undefined && v !== '')

/** Model for the review agent and the `/CodeSentinel` mention agent. */
export const resolveModel = (env: Env, override?: string): string =>
  firstSet(override, env.CodeSentinel_MODEL) ?? DEFAULT_MODEL

/** Model for the QA lead + healer — the judgment tier. Inherits `CodeSentinel_MODEL`. */
export const resolveQaLeadModel = (env: Env, override?: string): string =>
  firstSet(override, env.CodeSentinel_QA_MODEL, env.CodeSentinel_MODEL) ?? DEFAULT_QA_LEAD_MODEL

/**
 * Model for the QA per-flow drivers — the cheap "hands" tier. Inherits the QA lead
 * knobs so setting `CodeSentinel_MODEL`/`CodeSentinel_QA_MODEL` moves the drivers too; falls back
 * to the general default only when nothing is configured (keeps the opus-lead/
 * sonnet-driver split as the zero-config cost optimisation).
 */
export const resolveQaDriverModel = (env: Env, override?: string): string =>
  firstSet(
    override,
    env.CodeSentinel_QA_DRIVER_MODEL,
    env.CodeSentinel_QA_MODEL,
    env.CodeSentinel_MODEL
  ) ?? DEFAULT_MODEL
