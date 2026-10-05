import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAggregateReport, runSingleLiveEval } from '../../scripts/eval-full'

describe('Live Full-Pipeline Evaluation (E7.3)', () => {
  const isEnabled = process.env.EVAL_FULL === '1'

  it.runIf(isEnabled)(
    'executes live Run 1 and Run 2 against openai-codex/gpt-5.6-luna and saves raw JSON',
    async () => {
      const resultsDir = path.join(process.cwd(), 'eval-results')
      await fs.mkdir(resultsDir, { recursive: true })

      // Run 1: Normal execution
      const run1 = await runSingleLiveEval(1, false)
      await fs.writeFile(
        path.join(resultsDir, 'full-run-1.json'),
        JSON.stringify(run1, null, 2)
      )
      console.log('\n[CodeSentinel:EvalFull] Saved eval-results/full-run-1.json\n')

      // Run 2: Forced analyzer timeout execution
      const run2 = await runSingleLiveEval(2, true)
      await fs.writeFile(
        path.join(resultsDir, 'full-run-2.json'),
        JSON.stringify(run2, null, 2)
      )
      console.log('\n[CodeSentinel:EvalFull] Saved eval-results/full-run-2.json\n')

      const aggregate = buildAggregateReport('openai-codex/gpt-5.6-luna', 'current', [
        run1,
        run2,
      ])
      await fs.writeFile(
        path.join(resultsDir, 'full-pipeline-summary.json'),
        JSON.stringify(aggregate, null, 2)
      )

      console.log('\n--- RAW LIVE EVALUATION RESULTS ---')
      console.log(aggregate.markdownTable)

      expect(run1.findings.length).toBeGreaterThan(0)
      expect(run2.findings.length).toBeGreaterThan(0)
      expect(run1.metrics.tpCount).toBeGreaterThanOrEqual(10)
    },
    600000 // 10 minutes timeout for both runs
  )
})
