import { defineTool } from '@flue/runtime'
import * as v from 'valibot'
import { getOrCreateCollector } from '../graph/collector'
import { traced } from '../observability/tools'

export const triageFindingInputSchema = v.object({
  id: v.pipe(
    v.string(),
    v.minLength(1),
    v.description('ID of the pre-detected finding to triage.')
  ),
  decision: v.pipe(
    v.picklist(['confirm', 'dismiss']),
    v.description(
      'Whether to confirm the finding as genuine or dismiss it as a false positive.'
    )
  ),
  rationale: v.pipe(
    v.string(),
    v.minLength(1),
    v.description(
      'Concise engineering reasoning explaining why this finding is confirmed or dismissed.'
    )
  ),
})

export type TriageFindingInput = v.InferOutput<typeof triageFindingInputSchema>

export const createTriageFindingTool = () =>
  traced(
    defineTool({
      name: 'triage_finding',
      description:
        'Triage a pre-detected finding from static analysis or AST checks. Confirm or dismiss with engineering rationale.',
      input: triageFindingInputSchema,
      run: async ({ input }) => {
        const runId =
          process.env.CodeSentinel_RUN_ID ??
          process.env.CODESENTINEL_RUN_ID ??
          'default-run'
        const collector = getOrCreateCollector(runId)

        collector.triageFinding(input.id, input.decision, input.rationale)
        return `triaged ${input.id} as ${input.decision}`
      },
    })
  )
