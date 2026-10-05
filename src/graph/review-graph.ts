import {
  type BaseCheckpointSaver,
  END,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph'
import { withNodeSpan } from '../observability/trace'
import { type ExtractAstDeps, extractAst } from './nodes/extract-ast'
import { failureAnalysis } from './nodes/failure-analysis'
import { type HumanReviewDeps, humanReview } from './nodes/human-review'
import { type IngestDeps, ingest } from './nodes/ingest'
import { type LlmTriageDeps, llmTriage } from './nodes/llm-triage'
import { type ReportDeps, report } from './nodes/report'
import { type StaticAnalysisDeps, staticAnalysis } from './nodes/static-analysis'
import { type ValidateDeps, validate } from './nodes/validate'
import { ReviewState, type ReviewStateType } from './state'

export interface ReviewGraphDeps {
  ingest?: IngestDeps
  extractAst?: ExtractAstDeps
  staticAnalysis?: StaticAnalysisDeps
  llmTriage?: LlmTriageDeps
  validate?: ValidateDeps
  humanReview?: HumanReviewDeps
  report?: ReportDeps
  checkpointer?: BaseCheckpointSaver
}

export const buildReviewGraph = (deps: ReviewGraphDeps = {}) => {
  const hasNewErrors = (s: ReviewStateType, ...stages: string[]): boolean => {
    const unhandled = s.errors.slice(s.handledErrorCount)
    return unhandled.some((e) => stages.includes(e.stage))
  }

  const workflow = new StateGraph(ReviewState)
    /* eslint-disable @typescript-eslint/no-explicit-any */
    .addNode('ingest', withNodeSpan('ingest', ingest(deps.ingest)) as any)
    .addNode(
      'extract_ast',
      withNodeSpan('extract_ast', extractAst(deps.extractAst)) as any
    )
    .addNode(
      'static_analysis',
      withNodeSpan('static_analysis', staticAnalysis(deps.staticAnalysis)) as any
    )
    .addNode('llm_triage', withNodeSpan('llm_triage', llmTriage(deps.llmTriage)) as any)
    .addNode('validate', withNodeSpan('validate', validate(deps.validate)) as any)
    .addNode('failure_analysis', withNodeSpan('failure_analysis', failureAnalysis) as any)
    .addNode(
      'human_review',
      withNodeSpan('human_review', humanReview(deps.humanReview)) as any
    )
    .addNode('report', withNodeSpan('report', report(deps.report)) as any)
    /* eslint-enable @typescript-eslint/no-explicit-any */

    .addEdge(START, 'ingest')
    .addConditionalEdges('ingest', (s: ReviewStateType) =>
      s.files.length > 0 ? 'extract_ast' : END
    )
    .addEdge('extract_ast', 'static_analysis')
    .addConditionalEdges('static_analysis', (s: ReviewStateType) =>
      hasNewErrors(s, 'static_analysis') ? 'failure_analysis' : 'llm_triage'
    )
    .addEdge('llm_triage', 'validate')
    .addConditionalEdges('validate', (s: ReviewStateType) =>
      hasNewErrors(s, 'validate', 'llm_triage') ? 'failure_analysis' : 'human_review'
    )
    .addConditionalEdges('failure_analysis', (s: ReviewStateType) => {
      const retry = s.recovery?.retry
      if (retry === 'static_analysis') return 'static_analysis'
      if (retry === 'llm_triage') return 'llm_triage'
      // If recovery retry is null or non-retryable error, advance pipeline
      if ((s.attempts?.llm_triage ?? 0) === 0 && !s.degraded.includes('llm_triage')) {
        return 'llm_triage'
      }
      return 'human_review'
    })
    .addEdge('human_review', 'report')
    .addEdge('report', END)

  const checkpointer = deps.checkpointer ?? defaultMemorySaver
  return workflow.compile({ checkpointer })
}

export const defaultMemorySaver = new MemorySaver()
