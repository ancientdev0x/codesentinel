import type { ReviewStateType, ReviewStateUpdate } from '../state'

export const failureAnalysis = async (
  state: ReviewStateType
): Promise<ReviewStateUpdate> => {
  const attempts = {
    ...state.attempts,
    failure_analysis: (state.attempts?.failure_analysis ?? 0) + 1,
  }

  const unhandledErrors = state.errors.slice(state.handledErrorCount)
  if (unhandledErrors.length === 0) {
    return {
      recovery: null,
      handledErrorCount: state.errors.length,
      attempts,
    }
  }

  const degraded = [...state.degraded]
  const staticAttempts = state.attempts?.static_analysis ?? 0
  const llmAttempts = state.attempts?.llm_triage ?? 0
  const maxAttempts = state.cfg.maxAttempts ?? 3

  // 1. Check static_analysis errors
  const staticErrors = unhandledErrors.filter((e) => e.stage === 'static_analysis')
  if (staticErrors.length > 0) {
    const timeoutErr = staticErrors.find((e) => e.kind === 'timeout')
    if (timeoutErr && staticAttempts <= 1) {
      const currentTimeout = state.cfg.analyzerTimeoutMs ?? 5000
      return {
        recovery: {
          retry: 'static_analysis',
          hints: [
            `Timeout on tool ${timeoutErr.tool ?? 'analyzer'}, retrying with doubled timeout.`,
          ],
          adjust: {
            timeoutMs: currentTimeout * 2,
          },
        },
        handledErrorCount: state.errors.length,
        attempts,
      }
    }

    const unavailDockerErr = staticErrors.find(
      (e) => e.kind === 'unavailable' && state.cfg.sandbox !== 'host'
    )
    if (unavailDockerErr && staticAttempts <= 1) {
      return {
        recovery: {
          retry: 'static_analysis',
          hints: ['Docker backend unavailable, falling back to host execution backend.'],
          adjust: {
            backend: 'host',
          },
        },
        handledErrorCount: state.errors.length,
        attempts,
      }
    }

    // Degrade failed static analysis tools
    for (const err of staticErrors) {
      if (err.tool && !degraded.includes(err.tool)) {
        degraded.push(err.tool)
      }
    }
  }

  // 2. Check validation and llm_triage errors
  const validationErrors = unhandledErrors.filter(
    (e) => e.stage === 'validate' || e.stage === 'llm_triage'
  )

  if (validationErrors.length > 0) {
    const providerErr = validationErrors.find((e) => e.kind === 'provider_error')
    if (providerErr && llmAttempts < 2) {
      return {
        recovery: {
          retry: 'llm_triage',
          hints: [`LLM provider error (${providerErr.detail}); retrying.`],
        },
        degraded,
        handledErrorCount: state.errors.length,
        attempts,
      }
    }

    const emptyReviewErr = validationErrors.find((e) => e.kind === 'empty_review')
    if (emptyReviewErr && llmAttempts <= 1) {
      return {
        recovery: {
          retry: 'llm_triage',
          hints: ['Review summary was empty; you must end with a complete summary.'],
        },
        degraded,
        handledErrorCount: state.errors.length,
        attempts,
      }
    }

    const findingViolations = validationErrors.filter(
      (e) =>
        e.kind === 'invalid_output' || e.kind === 'out_of_diff' || e.kind === 'bad_patch'
    )

    if (findingViolations.length > 0 && llmAttempts < maxAttempts) {
      const hints = findingViolations.map((v) => {
        if (v.findingId) {
          return `Finding ${v.findingId}: ${v.detail}`
        }
        return v.detail
      })

      return {
        recovery: {
          retry: 'llm_triage',
          hints,
        },
        degraded,
        handledErrorCount: state.errors.length,
        attempts,
      }
    }

    // Exceeded bounds for LLM findings
    if (findingViolations.length > 0 && llmAttempts >= maxAttempts) {
      if (!degraded.includes('llm_triage')) {
        degraded.push('llm_triage')
      }
    }
  }

  // Fallback: no further retries possible
  return {
    recovery: {
      retry: null,
      hints: [],
    },
    degraded,
    handledErrorCount: state.errors.length,
    attempts,
  }
}
