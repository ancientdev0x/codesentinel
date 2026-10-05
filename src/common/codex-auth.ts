import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/compat'
import { refreshOpenAICodexToken } from '@earendil-works/pi-ai/oauth'
import { registerApiProvider, registerProvider } from '@flue/runtime'

interface CodexAuthData {
  auth_mode?: string
  tokens?: {
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
}

let registered = false
let inMemoryToken: string | null = null

export function parseJwtExp(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

/**
 * Resolves a valid OpenAI Codex access token from environment or ~/.codex/auth.json.
 * Refreshes expiring tokens in memory without writing to disk.
 * Never logs or exposes secret tokens.
 */
export async function resolveCodexToken(): Promise<string> {
  if (inMemoryToken) {
    const exp = parseJwtExp(inMemoryToken)
    const nowSec = Math.floor(Date.now() / 1000)
    if (exp === null || exp - nowSec >= 300) {
      return inMemoryToken
    }
  }

  const envToken = process.env.CodeSentinel_CODEX_TOKEN
  if (envToken) {
    inMemoryToken = envToken
    return envToken
  }

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const authPath = path.join(codexHome, 'auth.json')

  let raw: string
  try {
    raw = await fsp.readFile(authPath, 'utf8')
  } catch {
    throw new Error('Unable to read Codex auth file at ' + authPath)
  }

  let data: CodexAuthData
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('Invalid JSON in Codex auth file')
  }

  const accessToken = data.tokens?.access_token
  const refreshToken = data.tokens?.refresh_token

  if (!accessToken) {
    throw new Error('No access_token found in Codex auth file')
  }

  const exp = parseJwtExp(accessToken)
  const nowSec = Math.floor(Date.now() / 1000)

  if (exp !== null && exp - nowSec < 300 && refreshToken) {
    try {
      const creds = await refreshOpenAICodexToken(refreshToken)
      if (creds?.access) {
        inMemoryToken = creds.access
        return creds.access
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to refresh Codex OAuth token: ${msg}`)
    }
  }

  inMemoryToken = accessToken
  return accessToken
}

/**
 * Registers the 'openai-codex' provider with @flue/runtime and ensures reasoning
 * effort is preserved for models like gpt-5.6-luna.
 */
export async function registerCodexProvider(
  modelSpec?: string,
  thinkingLevel?: string,
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  baseApiOverride?: { stream: any; streamSimple: any }
): Promise<void> {
  if (!modelSpec || !modelSpec.startsWith('openai-codex/')) {
    return
  }

  if (process.env.GITHUB_ACTIONS) {
    throw new Error('Codex subscription auth is local-only')
  }

  if (registered) {
    return
  }

  const token = await resolveCodexToken()
  const effectiveLevel =
    thinkingLevel ?? process.env.CodeSentinel_THINKING_LEVEL ?? 'medium'

  registerProvider('openai-codex', {
    apiKey: token,
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
  })

  const baseApi = baseApiOverride ?? openAICodexResponsesApi()
  /* eslint-disable @typescript-eslint/no-explicit-any */
  registerApiProvider({
    api: 'openai-codex-responses' as any,
    stream: (model: any, context: any, options: any) => {
      const patchedModel = { ...model, reasoning: true }
      const effort = options?.reasoningEffort ?? effectiveLevel
      if (process.env.CodeSentinel_DEBUG_LLM === '1') {
        console.log(`[CodeSentinel:LLM] body.reasoning.effort = '${effort}'`)
      }
      return baseApi.stream(patchedModel, context, {
        ...options,
        reasoningEffort: effort,
      })
    },
    streamSimple: (model: any, context: any, options: any) => {
      const patchedModel = { ...model, reasoning: true }
      const effort = options?.reasoning ?? effectiveLevel
      if (process.env.CodeSentinel_DEBUG_LLM === '1') {
        console.log(`[CodeSentinel:LLM] body.reasoning.effort = '${effort}'`)
      }
      return baseApi.streamSimple(patchedModel, context, {
        ...options,
        reasoning: effort,
      })
    },
  })
  /* eslint-enable @typescript-eslint/no-explicit-any */

  process.env.CodeSentinel_THINKING_LEVEL = effectiveLevel
  registered = true
}

export function resetCodexRegistration(): void {
  registered = false
  inMemoryToken = null
}
