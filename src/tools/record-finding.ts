import { defineTool } from '@flue/runtime'
import * as v from 'valibot'
import { getOrCreateCollector } from '../graph/collector'
import { traced } from '../observability/tools'
import type { Severity } from '../review/findings'

export const recordFindingInputSchema = v.object({
  file: v.pipe(
    v.string(),
    v.minLength(1),
    v.description('Repository-relative path to the file with the finding.')
  ),
  startLine: v.pipe(
    v.number(),
    v.minValue(1),
    v.description('1-based start line number of the issue in the new file.')
  ),
  endLine: v.pipe(
    v.number(),
    v.minValue(1),
    v.description('1-based end line number of the issue in the new file.')
  ),
  severity: v.pipe(
    v.picklist(['critical', 'high', 'medium', 'low', 'info']),
    v.description('Severity level of the security or code quality issue.')
  ),
  message: v.pipe(
    v.string(),
    v.minLength(1),
    v.description('Clear, actionable explanation of the vulnerability or defect.')
  ),
  cwe: v.optional(
    v.pipe(
      v.string(),
      v.description('Optional Common Weakness Enumeration ID, e.g. "CWE-78".')
    )
  ),
  fix: v.optional(
    v.object({
      replacement: v.pipe(
        v.string(),
        v.description('Concrete code replacement fixing the vulnerability.')
      ),
      startLine: v.pipe(
        v.number(),
        v.minValue(1),
        v.description('Start line in the file to replace.')
      ),
      endLine: v.pipe(
        v.number(),
        v.minValue(1),
        v.description('End line in the file to replace.')
      ),
    })
  ),
})

export type RecordFindingInput = v.InferOutput<typeof recordFindingInputSchema>

export const createRecordFindingTool = () =>
  traced(
    defineTool({
      name: 'record_finding',
      description:
        'Record a review finding into the pipeline state. Do not post inline comments directly. Provide file, exact line range, severity, and actionable message.',
      input: recordFindingInputSchema,
      run: async ({ input }) => {
        if (input.startLine > input.endLine) {
          throw new Error(
            `Invalid line range: startLine (${input.startLine}) cannot be greater than endLine (${input.endLine})`
          )
        }
        if (input.fix && input.fix.startLine > input.fix.endLine) {
          throw new Error(
            `Invalid fix line range: startLine (${input.fix.startLine}) cannot be greater than endLine (${input.fix.endLine})`
          )
        }

        const runId =
          process.env.CodeSentinel_RUN_ID ??
          process.env.CODESENTINEL_RUN_ID ??
          'default-run'
        const collector = getOrCreateCollector(runId)

        const id = collector.recordFinding({
          file: input.file,
          startLine: input.startLine,
          endLine: input.endLine,
          severity: input.severity as Severity,
          message: input.message,
          cwe: input.cwe,
          fix: input.fix,
        })

        return `recorded ${id}`
      },
    })
  )
