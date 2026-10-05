import { type PromptableSession, tracedPrompt } from '../../observability/tokens'
import { buildReviewPrompt } from '../../review/context'
import type { Finding } from '../../review/findings'
import { getOrCreateCollector } from '../collector'
import type { ReviewStateType, ReviewStateUpdate, StageError } from '../state'

export interface LlmTriageDeps {
  session?: PromptableSession
  sessionFactory?: () => Promise<PromptableSession>
  buildPrompt?: typeof buildReviewPrompt
  tracedPrompt?: typeof tracedPrompt
}

export const llmTriage = (deps: LlmTriageDeps = {}) => {
  const doBuildPrompt = deps.buildPrompt ?? buildReviewPrompt
  const doTracedPrompt = deps.tracedPrompt ?? tracedPrompt
  let activeSession: PromptableSession | undefined = deps.session

  return async (state: ReviewStateType): Promise<ReviewStateUpdate> => {
    const attempts = {
      ...state.attempts,
      llm_triage: (state.attempts?.llm_triage ?? 0) + 1,
    }

    try {
      if (!activeSession && deps.sessionFactory) {
        activeSession = await deps.sessionFactory()
      }

      if (!activeSession) {
        throw new Error('No Flue session available for llm_triage node')
      }

      const runId =
        process.env.CodeSentinel_RUN_ID ??
        process.env.CODESENTINEL_RUN_ID ??
        'default-run'
      const collector = getOrCreateCollector(runId)

      const isRetry = Boolean(state.recovery?.hints && state.recovery.hints.length > 0)
      let promptText: string

      if (isRetry && (state.attempts?.llm_triage ?? 0) > 0) {
        promptText = [
          'The previous review attempt produced errors that need self-correction:',
          ...state.recovery!.hints.map((h) => `- ${h}`),
          'Please address the above issues, adjust or record valid findings with record_finding, and conclude with your final review summary.',
        ].join('\n')
      } else {
        promptText = doBuildPrompt(
          {
            files: state.files,
            fragments: state.fragments,
            findings: state.staticFindings,
            astChecks: state.cfg.astChecks,
          },
          state.cfg.workspace
        )
      }

      const response = await doTracedPrompt(activeSession, promptText, {
        model: state.cfg.model,
      })
      const summaryText = response.text?.trim() ?? ''

      const llmFindings = collector.getFindings()
      const triageDecisions = collector.getTriageDecisions()

      // Update static findings with triage decisions from the collector
      const updatedStaticFindings: Finding[] = state.staticFindings.map((f) => {
        const decision = triageDecisions.get(f.id)
        if (decision) {
          return {
            ...f,
            status: decision.decision === 'confirm' ? 'confirmed' : 'dismissed',
            rationale: decision.rationale,
          }
        }
        return f
      })

      return {
        staticFindings: updatedStaticFindings,
        llmFindings,
        summary: summaryText,
        attempts,
      }
    } catch (err) {
      const isProviderError =
        err instanceof Error &&
        (err.message.includes('429') ||
          err.message.includes('500') ||
          err.message.includes('503') ||
          err.message.includes('rate limit') ||
          err.message.includes('timeout'))

      const error: StageError = {
        stage: 'llm_triage',
        kind: isProviderError ? 'provider_error' : 'crash',
        detail: err instanceof Error ? err.message : String(err),
      }
      return {
        errors: [error],
        attempts,
      }
    }
  }
}
