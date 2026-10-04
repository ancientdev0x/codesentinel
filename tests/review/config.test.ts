import { describe, expect, test } from 'vitest'
import { resolveReviewConfig } from '../../src/review/config'

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv

describe('resolveReviewConfig', () => {
  test('defaults with empty env', () => {
    const cfg = resolveReviewConfig(undefined, env({}))
    expect(cfg.platform).toBe('local')
    expect(cfg.model).toBe('anthropic/claude-sonnet-4-6')
    expect(cfg.thinkingLevel).toBe('medium')
    expect(cfg.reviewLanguage).toBe('English')
    expect(cfg.mcpServers).toEqual({})
    expect(cfg.github).toBeUndefined()
  })

  test('payload overrides env', () => {
    const cfg = resolveReviewConfig(
      { model: 'openai/gpt-4.1-mini', reviewLanguage: 'French' },
      env({ CodeSentinel_MODEL: 'anthropic/other' })
    )
    expect(cfg.model).toBe('openai/gpt-4.1-mini')
    expect(cfg.reviewLanguage).toBe('French')
  })

  test('github platform resolves target + shas from env', () => {
    const cfg = resolveReviewConfig(
      undefined,
      env({
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
        CodeSentinel_PR_NUMBER: '42',
        GITHUB_TOKEN: 'tok',
        BASE_SHA: 'base',
        HEAD_SHA: 'head',
      })
    )
    expect(cfg.platform).toBe('github')
    expect(cfg.github).toEqual({
      owner: 'owner',
      repo: 'repo',
      prNumber: 42,
      token: 'tok',
    })
    expect(cfg.baseSha).toBe('base')
    expect(cfg.headSha).toBe('head')
  })

  test('github platform without a PR number has no target', () => {
    const cfg = resolveReviewConfig(
      undefined,
      env({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r' })
    )
    expect(cfg.platform).toBe('github')
    expect(cfg.github).toBeUndefined()
  })

  test('CodeSentinel_IGNORE is split and trimmed', () => {
    const cfg = resolveReviewConfig(
      undefined,
      env({ CodeSentinel_IGNORE: '**/*.test.ts, dist/** ,*.md' })
    )
    expect(cfg.ignore).toEqual(['**/*.test.ts', 'dist/**', '*.md'])
  })

  test('MCP servers from env: bare map', () => {
    const cfg = resolveReviewConfig(
      undefined,
      env({ CodeSentinel_MCP_SERVERS: JSON.stringify({ ctx7: { url: 'https://x' } }) })
    )
    expect(cfg.mcpServers).toEqual({ ctx7: { url: 'https://x' } })
  })

  test('MCP servers from env: { mcpServers } wrapper', () => {
    const cfg = resolveReviewConfig(
      undefined,
      env({
        CodeSentinel_MCP_SERVERS: JSON.stringify({ mcpServers: { a: { url: 'u' } } }),
      })
    )
    expect(cfg.mcpServers).toEqual({ a: { url: 'u' } })
  })

  test('invalid MCP JSON falls back to empty', () => {
    const cfg = resolveReviewConfig(
      undefined,
      env({ CodeSentinel_MCP_SERVERS: 'not json' })
    )
    expect(cfg.mcpServers).toEqual({})
  })

  test('payload mcpServers wins over env', () => {
    const cfg = resolveReviewConfig(
      { mcpServers: { p: { url: 'payload' } } },
      env({ CodeSentinel_MCP_SERVERS: JSON.stringify({ e: { url: 'env' } }) })
    )
    expect(cfg.mcpServers).toEqual({ p: { url: 'payload' } })
  })

  describe('feature flags precedence', () => {
    test('defaults when neither payload nor env is provided', () => {
      const cfg = resolveReviewConfig(undefined, env({}))
      expect(cfg.staticAnalysis).toBe(true)
      expect(cfg.sandbox).toBe('auto')
      expect(cfg.analyzerTimeoutMs).toBe(60000)
      expect(cfg.astChecks).toBe(true)
      expect(cfg.hitlMode).toBe('suggest')
      expect(cfg.maxAttempts).toBe(3)
      expect(cfg.prUrl).toBeUndefined()
    })

    test('env overrides defaults', () => {
      const cfg = resolveReviewConfig(
        undefined,
        env({
          CodeSentinel_STATIC_ANALYSIS: 'false',
          CodeSentinel_SANDBOX: 'host',
          CodeSentinel_ANALYZER_TIMEOUT_MS: '45000',
          CodeSentinel_AST_CHECKS: 'false',
          CodeSentinel_HITL_MODE: 'interactive',
          CodeSentinel_MAX_ATTEMPTS: '5',
          CodeSentinel_PR_URL: 'https://github.com/owner/repo/pull/123',
        })
      )
      expect(cfg.staticAnalysis).toBe(false)
      expect(cfg.sandbox).toBe('host')
      expect(cfg.analyzerTimeoutMs).toBe(45000)
      expect(cfg.astChecks).toBe(false)
      expect(cfg.hitlMode).toBe('interactive')
      expect(cfg.maxAttempts).toBe(5)
      expect(cfg.prUrl).toBe('https://github.com/owner/repo/pull/123')
    })

    test('payload overrides env and defaults', () => {
      const cfg = resolveReviewConfig(
        {
          staticAnalysis: true,
          sandbox: 'docker',
          analyzerTimeoutMs: 30000,
          astChecks: true,
          hitlMode: 'off',
          maxAttempts: 2,
          prUrl: 'https://github.com/owner/repo/pull/999',
        },
        env({
          CodeSentinel_STATIC_ANALYSIS: 'false',
          CodeSentinel_SANDBOX: 'host',
          CodeSentinel_ANALYZER_TIMEOUT_MS: '45000',
          CodeSentinel_AST_CHECKS: 'false',
          CodeSentinel_HITL_MODE: 'interactive',
          CodeSentinel_MAX_ATTEMPTS: '5',
          CodeSentinel_PR_URL: 'https://github.com/owner/repo/pull/123',
        })
      )
      expect(cfg.staticAnalysis).toBe(true)
      expect(cfg.sandbox).toBe('docker')
      expect(cfg.analyzerTimeoutMs).toBe(30000)
      expect(cfg.astChecks).toBe(true)
      expect(cfg.hitlMode).toBe('off')
      expect(cfg.maxAttempts).toBe(2)
      expect(cfg.prUrl).toBe('https://github.com/owner/repo/pull/999')
    })
  })
})
