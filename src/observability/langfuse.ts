import { LangfuseSpanProcessor } from '@langfuse/otel'
import { NodeSDK } from '@opentelemetry/sdk-node'

export const SECRET_PATTERN = /(?:sk-|ghp_|github_pat_)[A-Za-z0-9_]+/g
export const MAX_STRING_BYTES = 8192

/**
 * Sanitizes and truncates sensitive data before it is exported in spans.
 * Caches and masks tokens, API keys, and limits payload sizes to 8 KB.
 */
export const maskSensitiveData = ({ data }: { data: unknown }): unknown => {
  if (data === null || data === undefined) return data

  if (typeof data === 'string') {
    let masked = data.replace(SECRET_PATTERN, '[REDACTED_SECRET]')

    // Mask specific known environment secrets if present
    const envSecrets = [
      process.env.GITHUB_TOKEN,
      process.env.ANTHROPIC_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.LANGFUSE_SECRET_KEY,
    ].filter((s): s is string => Boolean(s && s.length >= 8))

    for (const secret of envSecrets) {
      if (masked.includes(secret)) {
        masked = masked.replaceAll(secret, '[REDACTED_SECRET]')
      }
    }

    if (masked.length > MAX_STRING_BYTES) {
      return `${masked.slice(0, MAX_STRING_BYTES)}... [TRUNCATED]`
    }
    return masked
  }

  if (Array.isArray(data)) {
    return data.map((item) => maskSensitiveData({ data: item }))
  }

  if (typeof data === 'object') {
    const res: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(data)) {
      // Direct token field scrubbing
      if (
        /token|secret|password|key|auth/i.test(key) &&
        typeof val === 'string' &&
        val.length > 0
      ) {
        res[key] = '[REDACTED_SECRET]'
      } else {
        res[key] = maskSensitiveData({ data: val })
      }
    }
    return res
  }

  return data
}

let processor: LangfuseSpanProcessor | undefined
let sdk: NodeSDK | undefined

export interface TracingState {
  enabled: boolean
  processor?: LangfuseSpanProcessor
  sdk?: NodeSDK
}

/**
 * Initializes Langfuse OpenTelemetry tracing.
 * Completely no-op if LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is missing.
 */
export const initTracing = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const publicKey = env.LANGFUSE_PUBLIC_KEY
  const secretKey = env.LANGFUSE_SECRET_KEY

  if (!publicKey || !secretKey) {
    return false
  }

  if (sdk) {
    return true
  }

  processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl:
      env.LANGFUSE_BASE_URL ??
      env.LANGFUSE_BASEURL ??
      env.LANGFUSE_HOST ??
      'https://cloud.langfuse.com',
    environment: env.CodeSentinel_ENV ?? env.CODESENTINEL_ENV ?? env.NODE_ENV ?? 'ci',
    mask: maskSensitiveData,
  })

  sdk = new NodeSDK({
    spanProcessors: [processor],
  })

  sdk.start()
  return true
}

export const tracingLifecycle = {
  flushCount: 0,
  reset() {
    this.flushCount = 0
  },
}

/**
 * Flushes active spans to Langfuse.
 */
export const flushTracing = async (): Promise<void> => {
  tracingLifecycle.flushCount++
  if (processor) {
    await processor.forceFlush()
  }
}

/**
 * Shuts down tracing and frees SDK resources.
 */
export const shutdownTracing = async (): Promise<void> => {
  if (sdk) {
    await sdk.shutdown()
    sdk = undefined
    processor = undefined
  }
}

/**
 * Reset tracing state for testing.
 */
export const _resetTracingForTest = (): void => {
  sdk = undefined
  processor = undefined
}
