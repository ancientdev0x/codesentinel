import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSingleLiveEval } from '../../scripts/eval-full'

describe('Live Full-Pipeline Evaluation (E7.3)', () => {
  const isEnabled = process.env.EVAL_FULL === '1'

  it.runIf(isEnabled)(
    'executes live Run 3 with forced analyzer timeout and saves raw JSON',
    async () => {
      const resultsDir = path.join(process.cwd(), 'eval-results')
      await fs.mkdir(resultsDir, { recursive: true })

      // Run 3: Forced analyzer timeout execution
      const run3 = await runSingleLiveEval(3, true)
      await fs.writeFile(
        path.join(resultsDir, 'full-run-3.json'),
        JSON.stringify(run3, null, 2)
      )
      console.log('\n[CodeSentinel:EvalFull] Saved eval-results/full-run-3.json\n')

      expect(run3.findings.length).toBeGreaterThan(0)
      expect(run3.degraded).toContain('static_analysis')
      expect(run3.nodeSequence.length).toBeGreaterThan(0)
    },
    600000 // 10 minutes timeout
  )
})
