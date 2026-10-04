import type { ToolDefinition } from '@flue/runtime'
import { startObservation } from '@langfuse/tracing'
import { MAX_STRING_BYTES } from './langfuse'

export const TRACED = Symbol('TRACED')

export const isTraced = (tool: unknown): boolean => {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    Boolean((tool as Record<symbol, unknown>)[TRACED])
  )
}

export const truncateData = (val: unknown, maxLen = MAX_STRING_BYTES): unknown => {
  if (val === null || val === undefined) return val
  if (typeof val === 'string') {
    if (val.length > maxLen) {
      return `${val.slice(0, maxLen)}... [TRUNCATED]`
    }
    return val
  }
  if (Array.isArray(val)) {
    return val.map((x) => truncateData(x, maxLen))
  }
  if (typeof val === 'object') {
    const res: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val)) {
      res[k] = truncateData(v, maxLen)
    }
    return res
  }
  return val
}

/**
 * Wraps a tool definition to record observation span, execution latency, and error status in Langfuse.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export const traced = <T extends ToolDefinition<any, any>>(tool: T): T => {
  if (isTraced(tool)) {
    return tool
  }

  const originalRun = tool.run

  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  const wrappedRun = async (args: any) => {
    const obs = startObservation(
      `tool.${tool.name}`,
      { input: truncateData(args?.input ?? args) },
      { asType: 'tool' }
    )
    const t0 = performance.now()
    try {
      const out = await originalRun(args)
      const latencyMs = Math.round(performance.now() - t0)
      obs.update({
        output: truncateData(out),
        metadata: { latencyMs },
      })
      obs.end()
      return out
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

  const wrappedTool = {
    ...tool,
    [TRACED]: true,
    run: wrappedRun,
  }

  return wrappedTool as T
}

/**
 * Batch-wraps an array of tools with traced().
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export const traceTools = <T extends ToolDefinition<any, any>[]>(tools: T): T => {
  return tools.map((t) => traced(t)) as T
}
