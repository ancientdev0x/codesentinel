import { describe, expect, it } from 'vitest'
import type { PromptResponse } from '@flue/runtime'
import { tracedPrompt } from '../../src/observability/tokens'

describe('Tokens & generation observation tracking (E6.4)', () => {
  it('captures full token usage and costs from session prompt response', async () => {
    const mockResponse: PromptResponse = {
      text: 'Review looks good!',
      usage: {
        input: 1200,
        output: 300,
        cacheRead: 800,
        cacheWrite: 200,
        totalTokens: 1500,
        cost: {
          input: 0.0036,
          output: 0.0045,
          cacheRead: 0.0008,
          cacheWrite: 0.0006,
          total: 0.0089,
        },
      },
      model: {
        provider: 'anthropic',
        id: 'claude-3-5-sonnet',
      },
    }

    const mockSession = {
      prompt: async () => mockResponse,
    }

    const result = await tracedPrompt(mockSession, 'Review prompt', {
      model: 'anthropic/claude-3-5-sonnet',
    })

    expect(result.text).toBe('Review looks good!')
    expect(result.usage.input).toBe(1200)
    expect(result.usage.output).toBe(300)
    expect(result.usage.totalTokens).toBe(1500)
    expect(result.usage.cost.total).toBe(0.0089)
  })

  it('handles responses with minimal or missing usage without throwing', async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const mockSession = {
      prompt: async () => ({ text: 'ok' }) as PromptResponse,
    }

    const result = await tracedPrompt(mockSession, 'prompt')
    expect(result.text).toBe('ok')
  })

  it('propagates prompt errors', async () => {
    const mockSession = {
      prompt: async () => {
        throw new Error('API Rate Limited')
      },
    }

    await expect(tracedPrompt(mockSession, 'prompt')).rejects.toThrow('API Rate Limited')
  })
})
