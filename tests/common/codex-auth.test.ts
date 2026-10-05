import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getApiProvider } from '@earendil-works/pi-ai/compat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseJwtExp,
  registerCodexProvider,
  resetCodexRegistration,
  resolveCodexToken,
} from '../../src/common/codex-auth'

const mockRefresh = vi.fn()

vi.mock('@earendil-works/pi-ai/oauth', () => ({
  refreshOpenAICodexToken: (token: string) => mockRefresh(token),
}))

function makeJwt(expiresInSec: number, secretPayload = 'mock-payload'): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    data: secretPayload,
  }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${b64}.signature`
}

describe('Codex Auth and Provider Registration', () => {
  let tmpDir: string
  const originalEnv = { ...process.env }

  beforeEach(async () => {
    resetCodexRegistration()
    mockRefresh.mockReset()
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-test-'))
    process.env.CODEX_HOME = tmpDir
    delete process.env.CodeSentinel_CODEX_TOKEN
    delete process.env.GITHUB_ACTIONS
    delete process.env.CodeSentinel_DEBUG_LLM
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    resetCodexRegistration()
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('parses JWT exp claim accurately', () => {
    const freshJwt = makeJwt(600)
    const exp = parseJwtExp(freshJwt)
    expect(exp).not.toBeNull()
    const nowSec = Math.floor(Date.now() / 1000)
    expect(exp!).toBeGreaterThan(nowSec + 550)

    expect(parseJwtExp('not-a-jwt')).toBeNull()
    expect(parseJwtExp('header.invalid-base64.sig')).toBeNull()
  })

  it('reads token from auth.json and skips refresh when token is fresh', async () => {
    const freshToken = makeJwt(3600, 'secret-fresh-token-123')
    await fsp.writeFile(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: freshToken,
          refresh_token: 'mock-refresh-token',
        },
      })
    )

    const token = await resolveCodexToken()
    expect(token).toBe(freshToken)
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('refreshes token in memory when expiring within 5 minutes without writing to auth.json', async () => {
    const expiringToken = makeJwt(120, 'secret-expiring-token')
    const refreshedToken = makeJwt(3600, 'secret-refreshed-token')
    const authPath = path.join(tmpDir, 'auth.json')

    await fsp.writeFile(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: expiringToken,
          refresh_token: 'valid-refresh-token',
        },
      })
    )

    mockRefresh.mockResolvedValueOnce({
      access: refreshedToken,
      refresh: 'valid-refresh-token',
      expires: 3600,
    })

    const token = await resolveCodexToken()
    expect(token).toBe(refreshedToken)
    expect(mockRefresh).toHaveBeenCalledWith('valid-refresh-token')

    // Confirm auth.json was NOT written to disk
    const diskContent = await fsp.readFile(authPath, 'utf8')
    const parsedDisk = JSON.parse(diskContent)
    expect(parsedDisk.tokens.access_token).toBe(expiringToken)
  })

  it('throws when GITHUB_ACTIONS environment variable is set', async () => {
    process.env.GITHUB_ACTIONS = 'true'
    await expect(registerCodexProvider('openai-codex/gpt-5.6-luna')).rejects.toThrow(
      'Codex subscription auth is local-only'
    )
  })

  it('is a no-op for non-codex models', async () => {
    await registerCodexProvider('anthropic/claude-sonnet-4-6')
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('registers provider on flue and preserves reasoning:true and reasoningEffort', async () => {
    const freshToken = makeJwt(3600)
    process.env.CodeSentinel_CODEX_TOKEN = freshToken

    let capturedModel: any
    let capturedOptions: any

    const mockStreamSimple = vi.fn().mockImplementation((model, _ctx, opts) => {
      capturedModel = model
      capturedOptions = opts
      return { push: vi.fn(), end: vi.fn() }
    })
    const mockStream = vi.fn().mockImplementation((model, _ctx, opts) => {
      capturedModel = model
      capturedOptions = opts
      return { push: vi.fn(), end: vi.fn() }
    })

    await registerCodexProvider('openai-codex/gpt-5.6-luna', 'medium', {
      stream: mockStream,
      streamSimple: mockStreamSimple,
    })
    expect(process.env.CodeSentinel_THINKING_LEVEL).toBe('medium')

    const provider = getApiProvider('openai-codex-responses')
    expect(provider).toBeDefined()

    const testModel = {
      id: 'gpt-5.6-luna',
      name: 'gpt-5.6-luna',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: false,
    }

    // Call the registered provider streamSimple
    provider!.streamSimple(testModel as any, { messages: [] } as any, { apiKey: 'dummy' })

    // The wrapper should have set reasoning to true
    expect(capturedModel?.reasoning).toBe(true)
    expect(capturedOptions?.reasoning).toBe('medium')

    // Call the registered provider stream
    provider!.stream(testModel as any, { messages: [] } as any, { apiKey: 'dummy' })
    expect(capturedModel?.reasoning).toBe(true)
    expect(capturedOptions?.reasoningEffort).toBe('medium')
  })

  it('never leaks secret token strings in logs or errors', async () => {
    const secretValue = 'SUPER_SECRET_TOKEN_VALUE_XYZ_987'
    const consoleSpy = vi.spyOn(console, 'log')
    const errorSpy = vi.spyOn(console, 'error')
    const warnSpy = vi.spyOn(console, 'warn')

    // Test error when auth file has invalid JSON containing secret
    await fsp.writeFile(path.join(tmpDir, 'auth.json'), `{ "invalid": "${secretValue}"`)

    let caughtError: Error | undefined
    try {
      await resolveCodexToken()
    } catch (err) {
      caughtError = err as Error
    }

    expect(caughtError).toBeDefined()
    expect(caughtError!.message).not.toContain(secretValue)

    const allConsoleCalls = [
      ...consoleSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
    ].flat()

    for (const call of allConsoleCalls) {
      expect(String(call)).not.toContain(secretValue)
    }

    consoleSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
