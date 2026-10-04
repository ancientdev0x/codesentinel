import {
  type InferStateSchemaUpdate,
  type InferStateSchemaValue,
  ReducedValue,
  StateSchema,
} from '@langchain/langgraph'
import { z } from 'zod'
import type { ReviewConfig } from '../review/config'
import type { ReviewFileWithDiff } from '../review/diff'
import type { CodeFragment } from '../review/ast/fragments'
import type { Finding } from '../review/findings'

export interface StageError {
  stage: 'ingest' | 'extract_ast' | 'static_analysis' | 'llm_triage' | 'validate'
  kind:
    | 'timeout'
    | 'unavailable'
    | 'crash'
    | 'invalid_output'
    | 'out_of_diff'
    | 'bad_patch'
    | 'empty_review'
    | 'provider_error'
  detail: string
  findingId?: string
  tool?: string
}

export interface RecoveryPlan {
  retry: 'static_analysis' | 'llm_triage' | null
  hints: string[]
  adjust?: {
    timeoutMs?: number
    backend?: 'host'
    skipTools?: string[]
  }
}

export const errorsReducer = (a: StageError[] = [], b: StageError[] = []): StageError[] =>
  a.concat(b)

export const ReviewState = new StateSchema({
  cfg: z.custom<ReviewConfig>(),
  files: z.array(z.custom<ReviewFileWithDiff>()).default([]),
  fragments: z.array(z.custom<CodeFragment>()).default([]),
  staticFindings: z.array(z.custom<Finding>()).default([]),
  llmFindings: z.array(z.custom<Finding>()).default([]),
  summary: z.string().default(''),
  attempts: z.record(z.string(), z.number()).default({}), // per node: { llm_triage: 1, static_analysis: 0 }
  errors: new ReducedValue(
    z.array(z.custom<StageError>()).default(() => []),
    {
      inputSchema: z.array(z.custom<StageError>()),
      reducer: errorsReducer,
    }
  ),
  degraded: z.array(z.string()).default([]), // tools/stages skipped after unrecoverable failure
  recovery: z.custom<RecoveryPlan | null>().default(null),
  approvals: z.record(z.string(), z.enum(['approve', 'reject'])).default({}), // E5
  handledErrorCount: z.number().default(0),
})

export type ReviewStateType = InferStateSchemaValue<typeof ReviewState.fields>
export type ReviewStateUpdate = InferStateSchemaUpdate<typeof ReviewState.fields>
