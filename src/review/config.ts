import type { ThinkingLevel } from '@flue/runtime'
import { resolveModel } from '../common/models'

/**
 * Remote MCP server entry. Flue only supports remote (HTTP/SSE) MCP transports,
 * so unlike the old `.mcp.json` there is no `command`/stdio option. MCP servers
 * are supplied via the GitHub Action config (payload or `CodeSentinel_MCP_SERVERS`),
 * never from a checked-in `.mcp.json`.
 */
export interface McpServerInput {
  url: string
  transport?: 'streamable-http' | 'sse'
  headers?: Record<string, string>
}

export type ReviewPlatform = 'github' | 'local'

/** Payload accepted by the `review` workflow (`flue run review --payload '{...}'`). */
export interface ReviewPayload {
  platform?: ReviewPlatform
  /** Path to the repository checkout to review. Defaults to GITHUB_WORKSPACE or cwd. */
  workspace?: string
  /** Flue model specifier, e.g. `anthropic/claude-sonnet-4-6`. */
  model?: string
  thinkingLevel?: ThinkingLevel
  reviewLanguage?: string
  ignore?: string[]
  customInstructions?: string
  /** Anonymous usage telemetry. Defaults to true; set false to opt out. */
  telemetry?: boolean
  owner?: string
  repo?: string
  prNumber?: number
  baseSha?: string
  headSha?: string
  mcpServers?: Record<string, McpServerInput>
  prUrl?: string
  staticAnalysis?: boolean
  sandbox?: 'docker' | 'host' | 'auto'
  analyzerTimeoutMs?: number
  astChecks?: boolean
  hitlMode?: 'off' | 'suggest' | 'interactive'
  maxAttempts?: number
}

export interface GithubTarget {
  owner: string
  repo: string
  prNumber: number
  token: string
}

export interface ReviewConfig {
  platform: ReviewPlatform
  workspace: string
  model: string
  thinkingLevel: ThinkingLevel
  reviewLanguage: string
  ignore?: string[]
  customInstructions?: string
  telemetry: boolean
  baseSha?: string
  headSha?: string
  github?: GithubTarget
  mcpServers: Record<string, McpServerInput>
  prUrl?: string
  staticAnalysis: boolean
  sandbox: 'docker' | 'host' | 'auto'
  analyzerTimeoutMs: number
  astChecks: boolean
  hitlMode: 'off' | 'suggest' | 'interactive'
  maxAttempts: number
}

const DEFAULT_THINKING: ThinkingLevel = 'medium'

const parseMcpServers = (
  payload: ReviewPayload,
  env: NodeJS.ProcessEnv
): Record<string, McpServerInput> => {
  if (payload.mcpServers && Object.keys(payload.mcpServers).length > 0) {
    return payload.mcpServers
  }
  const raw = env.CodeSentinel_MCP_SERVERS
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Accept either a bare map of servers or a `{ mcpServers: {...} }` wrapper.
    const servers =
      parsed && typeof parsed === 'object' && 'mcpServers' in parsed
        ? (parsed.mcpServers as Record<string, McpServerInput>)
        : (parsed as Record<string, McpServerInput>)
    return servers ?? {}
  } catch {
    return {}
  }
}

/**
 * Resolves the full review configuration from the workflow payload and the
 * environment. Payload values win; GitHub Actions env vars fill the gaps.
 */
export const resolveReviewConfig = (
  payload: ReviewPayload | undefined,
  env: NodeJS.ProcessEnv = process.env
): ReviewConfig => {
  const p = payload ?? {}

  const platform: ReviewPlatform = p.platform ?? (env.GITHUB_ACTIONS ? 'github' : 'local')
  const workspace = p.workspace ?? env.GITHUB_WORKSPACE ?? process.cwd()
  const model = resolveModel(env, p.model)
  const thinkingLevel =
    p.thinkingLevel ??
    (env.CodeSentinel_THINKING_LEVEL as ThinkingLevel) ??
    DEFAULT_THINKING
  const reviewLanguage = p.reviewLanguage ?? env.CodeSentinel_REVIEW_LANGUAGE ?? 'English'
  const baseSha = p.baseSha ?? env.BASE_SHA
  const headSha = p.headSha ?? env.HEAD_SHA ?? env.GITHUB_SHA

  const ignore =
    p.ignore ??
    (env.CodeSentinel_IGNORE
      ? env.CodeSentinel_IGNORE.split(',')
          .map((g) => g.trim())
          .filter(Boolean)
      : undefined)
  const customInstructions = p.customInstructions ?? env.CodeSentinel_CUSTOM_INSTRUCTIONS
  const telemetry = p.telemetry ?? env.CodeSentinel_TELEMETRY !== 'false'

  let github: GithubTarget | undefined
  if (platform === 'github') {
    const repoSlug = env.GITHUB_REPOSITORY ?? '/'
    const owner = p.owner ?? repoSlug.split('/')[0]
    const repo = p.repo ?? repoSlug.split('/')[1]
    const prNumber = p.prNumber ?? Number(env.CodeSentinel_PR_NUMBER ?? '0')
    const token = env.GITHUB_TOKEN ?? ''
    if (owner && repo && prNumber > 0) {
      github = { owner, repo, prNumber, token }
    }
  }

  const prUrl = p.prUrl ?? env.CodeSentinel_PR_URL ?? env.CODESENTINEL_PR_URL
  const staticAnalysis =
    p.staticAnalysis ??
    (env.CodeSentinel_STATIC_ANALYSIS !== undefined
      ? env.CodeSentinel_STATIC_ANALYSIS !== 'false'
      : env.CODESENTINEL_STATIC_ANALYSIS !== undefined
        ? env.CODESENTINEL_STATIC_ANALYSIS !== 'false'
        : true)
  const sandbox =
    p.sandbox ??
    ((env.CodeSentinel_SANDBOX ?? env.CODESENTINEL_SANDBOX) as
      | 'docker'
      | 'host'
      | 'auto'
      | undefined) ??
    'auto'
  const analyzerTimeoutMs =
    p.analyzerTimeoutMs ??
    Number(
      env.CodeSentinel_ANALYZER_TIMEOUT_MS ??
        env.CODESENTINEL_ANALYZER_TIMEOUT_MS ??
        '60000'
    )
  const astChecks =
    p.astChecks ??
    (env.CodeSentinel_AST_CHECKS !== undefined
      ? env.CodeSentinel_AST_CHECKS !== 'false'
      : env.CODESENTINEL_AST_CHECKS !== undefined
        ? env.CODESENTINEL_AST_CHECKS !== 'false'
        : true)
  const hitlMode =
    p.hitlMode ??
    ((env.CodeSentinel_HITL_MODE ?? env.CODESENTINEL_HITL_MODE) as
      | 'off'
      | 'suggest'
      | 'interactive'
      | undefined) ??
    'suggest'
  const maxAttempts =
    p.maxAttempts ??
    Number(env.CodeSentinel_MAX_ATTEMPTS ?? env.CODESENTINEL_MAX_ATTEMPTS ?? '3')

  return {
    platform,
    workspace,
    model,
    thinkingLevel,
    reviewLanguage,
    ignore,
    customInstructions,
    telemetry,
    baseSha,
    headSha,
    github,
    mcpServers: parseMcpServers(p, env),
    prUrl,
    staticAnalysis,
    sandbox,
    analyzerTimeoutMs,
    astChecks,
    hitlMode,
    maxAttempts,
  }
}

/**
 * Copies resolved review configuration into process.env before the flue agent
 * session is initialized.
 *
 * Why this exists:
 * In flue beta.9, agent initializers only receive `{ id, env }` (NodeJS process.env
 * or worker env) with no per-invocation payload. The workflow receives the payload,
 * resolves it into ReviewConfig, and must synchronize these values into process.env
 * so that createAgent and tool initializers see the user's payload overrides.
 */
export const applyPayloadToEnv = (
  cfg: ReviewConfig,
  targetEnv: NodeJS.ProcessEnv = process.env
): void => {
  if (cfg.model) targetEnv.CodeSentinel_MODEL = cfg.model
  if (cfg.thinkingLevel) targetEnv.CodeSentinel_THINKING_LEVEL = cfg.thinkingLevel
  if (cfg.reviewLanguage) targetEnv.CodeSentinel_REVIEW_LANGUAGE = cfg.reviewLanguage
  if (cfg.workspace) targetEnv.GITHUB_WORKSPACE = cfg.workspace
  if (cfg.baseSha) targetEnv.BASE_SHA = cfg.baseSha
  if (cfg.headSha) targetEnv.HEAD_SHA = cfg.headSha
  if (cfg.customInstructions)
    targetEnv.CodeSentinel_CUSTOM_INSTRUCTIONS = cfg.customInstructions
  if (cfg.ignore && cfg.ignore.length > 0)
    targetEnv.CodeSentinel_IGNORE = cfg.ignore.join(',')
  targetEnv.CodeSentinel_TELEMETRY = String(cfg.telemetry)
  targetEnv.CodeSentinel_STATIC_ANALYSIS = String(cfg.staticAnalysis)
  targetEnv.CodeSentinel_SANDBOX = cfg.sandbox
  targetEnv.CodeSentinel_ANALYZER_TIMEOUT_MS = String(cfg.analyzerTimeoutMs)
  targetEnv.CodeSentinel_AST_CHECKS = String(cfg.astChecks)
  targetEnv.CodeSentinel_HITL_MODE = cfg.hitlMode
  targetEnv.CodeSentinel_MAX_ATTEMPTS = String(cfg.maxAttempts)
  if (cfg.prUrl) targetEnv.CodeSentinel_PR_URL = cfg.prUrl
  if (cfg.github) {
    targetEnv.CodeSentinel_PR_NUMBER = String(cfg.github.prNumber)
    targetEnv.GITHUB_REPOSITORY = `${cfg.github.owner}/${cfg.github.repo}`
    if (cfg.github.token) targetEnv.GITHUB_TOKEN = cfg.github.token
  }
}
