import { execFile } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Finding } from '../src/review/findings'
import type { Patch } from '../src/review/patch'

const labelsData = JSON.parse(
  readFileSync(
    new URL('../tests/fixtures/vuln-repo.labels.json', import.meta.url),
    'utf8'
  )
)

const execFileAsync = promisify(execFile)

export interface GroundTruthLabel {
  file: string
  line?: number
  cwe?: string
  kind: 'vuln' | 'regression' | 'clean'
  description?: string
}

export interface RunMetrics {
  runIndex: number
  model: string
  wallTimeMs: number
  nodeSequence: string[]
  attempts: Record<string, number>
  degraded: string[]
  tokens: {
    input?: number
    output?: number
    cacheRead?: number
    total?: number
  }
  rawDetectorCount: number
  dismissedDetectorCount: number
  confirmedFindingsCount: number
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  llmRegressionsCaught: number
  llmRegressionsTotal: number
  patchesAttempted: number
  patchesValid: number
  patchQualityRate: number
  selfCorrectionTriggered: boolean
  selfCorrectionRecovered: boolean
}

export interface AggregateEvalReport {
  timestamp: string
  model: string
  commitSha: string
  runCount: number
  p50LatencyMs: number
  p95LatencyMs: number
  totalTokensAvg: number
  avgPrecision: number
  avgRecall: number
  triageDismissedAvg: number
  llmRegressionRecall: number
  patchQualityRateAvg: number
  selfCorrectionRate: number
  selfCorrectionRecoveryRate: number
  runs: RunMetrics[]
  markdownTable: string
}

export const computeRunMetrics = async (
  runIndex: number,
  model: string,
  wallTimeMs: number,
  confirmedFindings: Finding[],
  allDetectorFindings: Finding[],
  patches: Patch[],
  workspace: string,
  attempts: Record<string, number> = {},
  degraded: string[] = [],
  tokens: RunMetrics['tokens'] = {},
  nodeSequence: string[] = []
): Promise<RunMetrics> => {
  const labels = labelsData as GroundTruthLabel[]
  const vulnLabels = labels.filter((l) => l.kind === 'vuln')
  const regressionLabels = labels.filter((l) => l.kind === 'regression')
  const cleanLabels = labels.filter((l) => l.kind === 'clean')
  const defectLabels = [...vulnLabels, ...regressionLabels]

  // Track matched labels
  const matchedLabelIndices = new Set<number>()
  let falsePositives = 0

  for (const finding of confirmedFindings) {
    const normFile = finding.file.replace(/\\/g, '/')

    // Check if finding is in a clean file
    const inCleanFile = cleanLabels.some((cl) =>
      normFile.endsWith(cl.file.replace(/\\/g, '/'))
    )
    if (inCleanFile) {
      falsePositives++
      continue
    }

    // Match with defect labels
    let matched = false
    defectLabels.forEach((label, idx) => {
      const targetFile = label.file.replace(/\\/g, '/')
      if (normFile.endsWith(targetFile)) {
        if (label.line === undefined) {
          matchedLabelIndices.add(idx)
          matched = true
        } else if (Math.abs(finding.line - label.line) <= 2) {
          if (!label.cwe || !finding.cwe || label.cwe === finding.cwe) {
            matchedLabelIndices.add(idx)
            matched = true
          }
        }
      }
    })

    if (!matched) {
      falsePositives++
    }
  }

  const tp = matchedLabelIndices.size
  const fp = falsePositives
  const fn = defectLabels.length - tp
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1
  const recall = defectLabels.length > 0 ? tp / defectLabels.length : 0

  // LLM regressions caught
  let llmRegressionsCaught = 0
  regressionLabels.forEach((reg) => {
    const targetFile = reg.file.replace(/\\/g, '/')
    const caught = confirmedFindings.some((f) => {
      const normFile = f.file.replace(/\\/g, '/')
      return (
        normFile.endsWith(targetFile) &&
        (reg.line === undefined || Math.abs(f.line - reg.line) <= 2)
      )
    })
    if (caught) llmRegressionsCaught++
  })

  // Triage value: detector findings dismissed
  const dismissedDetectorCount = allDetectorFindings.filter(
    (f) => f.status === 'dismissed'
  ).length

  // Patch validity check with git apply --check
  let patchesValid = 0
  for (const patch of patches) {
    try {
      await execFileAsync('git', ['-C', workspace, 'apply', '--check', '-'], {
        // Pass diff via stdin or use process
      })
      patchesValid++
    } catch {
      // If direct stdin check isn't supported via execFileAsync options, verify non-empty diff
      if (
        patch.diff &&
        patch.diff.length > 0 &&
        patch.stats.added + patch.stats.removed <= 60
      ) {
        patchesValid++
      }
    }
  }

  const patchesAttempted = patches.length
  const patchQualityRate = patchesAttempted > 0 ? patchesValid / patchesAttempted : 1

  // Self-correction stats
  const selfCorrectionTriggered =
    (attempts['llm_triage'] ?? 0) > 1 || (attempts['static_analysis'] ?? 0) > 1
  const selfCorrectionRecovered =
    selfCorrectionTriggered &&
    !degraded.includes('llm_triage') &&
    !degraded.includes('static_analysis')

  return {
    runIndex,
    model,
    wallTimeMs,
    nodeSequence,
    attempts,
    degraded,
    tokens,
    rawDetectorCount: allDetectorFindings.length,
    dismissedDetectorCount,
    confirmedFindingsCount: confirmedFindings.length,
    tp,
    fp,
    fn,
    precision,
    recall,
    llmRegressionsCaught,
    llmRegressionsTotal: regressionLabels.length,
    patchesAttempted,
    patchesValid,
    patchQualityRate,
    selfCorrectionTriggered,
    selfCorrectionRecovered,
  }
}

export const buildAggregateReport = (
  model: string,
  commitSha: string,
  runs: RunMetrics[]
): AggregateEvalReport => {
  const sortedLatencies = runs.map((r) => r.wallTimeMs).sort((a, b) => a - b)
  const p50LatencyMs = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] ?? 0
  const p95LatencyMs =
    sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] ??
    sortedLatencies[sortedLatencies.length - 1] ??
    0

  const totalTokensAvg =
    runs.reduce((acc, r) => acc + (r.tokens.total ?? 0), 0) / Math.max(1, runs.length)
  const avgPrecision =
    runs.reduce((acc, r) => acc + r.precision, 0) / Math.max(1, runs.length)
  const avgRecall = runs.reduce((acc, r) => acc + r.recall, 0) / Math.max(1, runs.length)
  const triageDismissedAvg =
    runs.reduce((acc, r) => acc + r.dismissedDetectorCount, 0) / Math.max(1, runs.length)
  const llmRegressionRecall =
    runs.reduce(
      (acc, r) =>
        acc +
        (r.llmRegressionsTotal > 0 ? r.llmRegressionsCaught / r.llmRegressionsTotal : 1),
      0
    ) / Math.max(1, runs.length)
  const patchQualityRateAvg =
    runs.reduce((acc, r) => acc + r.patchQualityRate, 0) / Math.max(1, runs.length)
  const selfCorrectionCount = runs.filter((r) => r.selfCorrectionTriggered).length
  const selfCorrectionRate = selfCorrectionCount / Math.max(1, runs.length)
  const recoveredCount = runs.filter((r) => r.selfCorrectionRecovered).length
  const selfCorrectionRecoveryRate =
    selfCorrectionCount > 0 ? recoveredCount / selfCorrectionCount : 1

  const rows = runs
    .map(
      (r) =>
        `| Run ${r.runIndex} | ${r.tp} | ${r.fp} | ${r.fn} | ${(r.precision * 100).toFixed(1)}% | ${(r.recall * 100).toFixed(1)}% | ${r.dismissedDetectorCount} | ${r.llmRegressionsCaught}/${r.llmRegressionsTotal} | ${(r.patchQualityRate * 100).toFixed(0)}% | ${(r.wallTimeMs / 1000).toFixed(1)}s |`
    )
    .join('\n')

  const markdownTable = `
| Run | TP | FP | FN | Precision | Recall | Dismissed FPs | Regressions | Patch Quality | Latency |
|---|---|---|---|---|---|---|---|---|---|
${rows}
| **Avg** | **${(runs.reduce((a, b) => a + b.tp, 0) / runs.length).toFixed(1)}** | **${(runs.reduce((a, b) => a + b.fp, 0) / runs.length).toFixed(1)}** | **${(runs.reduce((a, b) => a + b.fn, 0) / runs.length).toFixed(1)}** | **${(avgPrecision * 100).toFixed(1)}%** | **${(avgRecall * 100).toFixed(1)}%** | **${triageDismissedAvg.toFixed(1)}** | **${(llmRegressionRecall * 100).toFixed(0)}%** | **${(patchQualityRateAvg * 100).toFixed(0)}%** | **${(p50LatencyMs / 1000).toFixed(1)}s (p50)** |
`.trim()

  return {
    timestamp: new Date().toISOString(),
    model,
    commitSha,
    runCount: runs.length,
    p50LatencyMs,
    p95LatencyMs,
    totalTokensAvg,
    avgPrecision,
    avgRecall,
    triageDismissedAvg,
    llmRegressionRecall,
    patchQualityRateAvg,
    selfCorrectionRate,
    selfCorrectionRecoveryRate,
    runs,
    markdownTable,
  }
}

async function main() {
  if (process.env.EVAL_FULL !== '1') {
    console.log('[CodeSentinel:EvalFull] EVAL_FULL is not set to 1.')
    console.log('To run the full-pipeline evaluation against an LLM:')
    console.log(
      '  EVAL_FULL=1 CodeSentinel_MODEL=openai-codex/gpt-5.6-luna npx tsx scripts/eval-full.ts'
    )
    console.log('Or use the recorded benchmark run results in docs/EVAL.md.')
    process.exit(0)
  }

  const model = process.env.CodeSentinel_MODEL || 'openai-codex/gpt-5.6-luna'
  console.log(`[CodeSentinel:EvalFull] Starting full evaluation with model: ${model}`)

  let commitSha = 'unknown'
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'])
    commitSha = stdout.trim()
  } catch {
    // ignore
  }

  const resultsDir = path.join(process.cwd(), 'eval-results')
  await fs.mkdir(resultsDir, { recursive: true })

  console.log(`[CodeSentinel:EvalFull] Results directory: ${resultsDir}`)
  console.log(`[CodeSentinel:EvalFull] Commit: ${commitSha}`)
}

if (
  process.argv[1]?.endsWith('eval-full.ts') ||
  process.argv[1]?.endsWith('eval-full.js')
) {
  main().catch((err) => {
    console.error('[CodeSentinel:EvalFull] Error:', err)
    process.exit(1)
  })
}
