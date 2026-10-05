#!/usr/bin/env node
import { runDeterministicEval } from './deterministic'

async function main() {
  try {
    const report = await runDeterministicEval()
    console.log('\n--- CodeSentinel Deterministic Evaluation Results ---')
    console.log(report.markdownTable)
    console.log('-----------------------------------------------------\n')

    if (report.cleanFindingsCount > 0) {
      console.error(
        `[EVAL FAILURE] Found ${report.cleanFindingsCount} false positive findings on clean files.`
      )
      process.exit(1)
    }

    if (report.union.recall < 0.9) {
      console.error(
        `[EVAL FAILURE] Union recall ${report.union.recall} is below the 0.9 (90%) threshold.`
      )
      process.exit(1)
    }

    console.log('Evaluation PASSED: All recall and precision thresholds met.')
    process.exit(0)
  } catch (err) {
    console.error('[EVAL ERROR]', err)
    process.exit(1)
  }
}

main()
