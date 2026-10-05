import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTracingForTest,
  flushTracing,
  initTracing,
  maskSensitiveData,
  MAX_STRING_BYTES,
} from '../../src/observability/langfuse'

describe('Langfuse bootstrap & masking (E6.1)', () => {
  beforeEach(() => {
    _resetTracingForTest()
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    _resetTracingForTest()
  })

  it('is a complete no-op when LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is unset', () => {
    const started = initTracing({})
    expect(started).toBe(false)
  })

  it('masks standard tokens and secrets matching patterns', () => {
    const raw =
      'Authorization: Bearer sk-ant-api03-1234567890abcdef and ghp_ABC1234567890XYZ'
    const masked = maskSensitiveData({ data: raw })
    expect(masked).not.toContain('sk-ant-api03-1234567890abcdef')
    expect(masked).not.toContain('ghp_ABC1234567890XYZ')
    expect(masked).toContain('[REDACTED_SECRET]')
  })

  it('masks env-provided secrets when they appear in data', () => {
    process.env.GITHUB_TOKEN = 'secret-github-token-998877'
    const raw = 'Calling github with secret-github-token-998877 for pr 123'
    const masked = maskSensitiveData({ data: raw })
    expect(masked).not.toContain('secret-github-token-998877')
    expect(masked).toContain('[REDACTED_SECRET]')
    delete process.env.GITHUB_TOKEN
  })

  it('recursively masks objects and arrays', () => {
    const obj = {
      apiKey: 'plain-api-key',
      user: 'alice',
      headers: ['sk-1234567890abcdef', 'ok-header'],
    }
    const masked = maskSensitiveData({ data: obj }) as typeof obj
    expect(masked.apiKey).toBe('[REDACTED_SECRET]')
    expect(masked.user).toBe('alice')
    expect(masked.headers[0]).toBe('[REDACTED_SECRET]')
    expect(masked.headers[1]).toBe('ok-header')
  })

  it('truncates strings exceeding 8 KB limit', () => {
    const longString = 'a'.repeat(MAX_STRING_BYTES + 500)
    const masked = maskSensitiveData({ data: longString }) as string
    expect(masked.length).toBeLessThan(longString.length)
    expect(masked).toContain('... [TRUNCATED]')
  })

  it('initializes NodeSDK and LangfuseSpanProcessor when keys are present', async () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: 'pk-test',
      LANGFUSE_SECRET_KEY: 'sk-test',
      LANGFUSE_BASE_URL: 'https://test.langfuse.com',
    }

    const started = initTracing(env)
    expect(started).toBe(true)

    // flushTracing works safely
    await expect(flushTracing()).resolves.toBeUndefined()
  })
})
