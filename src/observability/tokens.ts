import type { FlueSession, PromptResponse } from '@flue/runtime'
import { startObservation } from '@langfuse/tracing'
import { truncateData } from './tools'

export interface TracedPromptOptions {
  model?: string
}

export type PromptableSession =
  | FlueSession
  | {
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      prompt: (
        text: string,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any
        options?: any
      ) => Promise<PromptResponse> | PromiseLike<PromptResponse>
    }

/**
 * Wraps a session.prompt() call in a Langfuse generation observation,
 * capturing exact input/output tokens, cache metrics, and cost details from Flue.
 */
export const tracedPrompt = async (
  session: PromptableSession,
  prompt: string,
  options?: TracedPromptOptions
): Promise<PromptResponse> => {
  const model = options?.model ?? 'default'
  const obs = startObservation(
    'llm',
    {
      model,
      input: truncateData(prompt),
    },
    { asType: 'generation' }
  )

  const t0 = performance.now()
  try {
    const res = await session.prompt(prompt)
    const latencyMs = Math.round(performance.now() - t0)

    const usage = res?.usage
    const usageDetails: Record<string, number> = {}
    const costDetails: Record<string, number> = {}

    if (usage) {
      if (typeof usage.input === 'number') usageDetails.input = usage.input
      if (typeof usage.output === 'number') usageDetails.output = usage.output
      if (typeof usage.totalTokens === 'number') usageDetails.total = usage.totalTokens
      if (typeof usage.cacheRead === 'number') {
        usageDetails.cache_read_input_tokens = usage.cacheRead
      }
      if (typeof usage.cacheWrite === 'number') {
        usageDetails.cache_creation_input_tokens = usage.cacheWrite
      }

      if (usage.cost) {
        if (typeof usage.cost.total === 'number') costDetails.total = usage.cost.total
        if (typeof usage.cost.input === 'number') costDetails.input = usage.cost.input
        if (typeof usage.cost.output === 'number') costDetails.output = usage.cost.output
      }
    }
    console.log(
      '[CodeSentinel:Tokens]',
      JSON.stringify({ ...usageDetails, ...(res?.usage ? { rawUsage: res.usage } : {}) })
    )

    obs.update({
      output: truncateData(res?.text ?? ''),
      usageDetails: Object.keys(usageDetails).length > 0 ? usageDetails : undefined,
      costDetails: Object.keys(costDetails).length > 0 ? costDetails : undefined,
      metadata: { latencyMs },
    })
    obs.end()

    return res
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0)
    obs.update({
      level: 'ERROR',
      statusMessage: err instanceof Error ? err.message : String(err),
      metadata: { latencyMs },
    })
    obs.end()
    throw err
  }
}
