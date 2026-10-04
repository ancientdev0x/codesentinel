import { propagateAttributes, startActiveObservation } from '@langfuse/tracing'
import { trace } from '@opentelemetry/api'
import * as v from 'valibot'

export const TraceMetadataSchema = v.object({
  repo: v.string(),
  pr: v.union([v.number(), v.string()]),
  runId: v.string(),
  model: v.string(),
  platform: v.picklist(['github', 'local']),
})

export type TraceMetadata = v.InferOutput<typeof TraceMetadataSchema>

export const validateTraceMetadata = (data: unknown): TraceMetadata => {
  return v.parse(TraceMetadataSchema, data)
}

export interface TraceMetadataInput {
  name?: string
  sessionId?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Summarizes state object into counts and primitives only, avoiding raw full source files.
 */
export const summarizeState = (state: unknown): Record<string, unknown> => {
  if (!state || typeof state !== 'object') return {}
  const s = state as Record<string, unknown>
  const summary: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(s)) {
    if (Array.isArray(v)) {
      summary[`${k}_count`] = v.length
    } else if (typeof v === 'string') {
      summary[k] = v.length > 200 ? `${v.slice(0, 200)}...` : v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      summary[k] = v
    } else if (typeof v === 'object' && v !== null) {
      summary[`${k}_keys`] = Object.keys(v).length
    }
  }

  return summary
}

/**
 * Summarizes the output delta returned from a graph node.
 */
export const summarizeDelta = (delta: unknown): Record<string, unknown> => {
  return summarizeState(delta)
}

/**
 * Runs a function within a context that propagates Langfuse attributes to all child spans.
 */
export const withTraceContext = <T>(
  params: {
    sessionId?: string
    userId?: string
    metadata?: Record<string, string>
    tags?: string[]
  },
  fn: () => T
): T => {
  return propagateAttributes(params, fn)
}

/**
 * Updates metadata on the active trace and sets session / context attributes on the active span.
 */
export const updateActiveTrace = (input: TraceMetadataInput): void => {
  const activeSpan = trace.getActiveSpan()
  if (activeSpan) {
    if (input.name) activeSpan.updateName(input.name)
    if (input.tags && input.tags.length > 0) {
      activeSpan.setAttribute('langfuse.trace.tags', JSON.stringify(input.tags))
    }
    if (input.sessionId) {
      activeSpan.setAttribute('langfuse.session.id', input.sessionId)
    }
    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        activeSpan.setAttribute(
          `metadata.${k}`,
          typeof v === 'string' ? v : JSON.stringify(v)
        )
      }
    }
  }
}

/**
 * Higher-order function wrapping a LangGraph state machine node in an active Langfuse span.
 */
export const withNodeSpan = <S extends { attempts?: Record<string, number> }>(
  name: string,
  fn: (s: S) => Promise<Partial<S> | void>
): ((s: S) => Promise<Partial<S> | void>) => {
  return (state: S) => {
    return startActiveObservation(`node.${name}`, async (span) => {
      const attempt = state?.attempts?.[name] ?? 0
      span.update({
        input: summarizeState(state),
        metadata: { attempt },
      })

      try {
        const out = await fn(state)
        span.update({
          output: summarizeDelta(out),
        })
        return out
      } catch (err) {
        span.update({
          level: 'ERROR',
          statusMessage: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    })
  }
}
