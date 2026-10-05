#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { makeRepo } from '../tests/helpers/makeRepo'
import type { Finding } from '../src/review/findings'

const execFileAsync = promisify(execFile)

export interface GroundTruthLabel {
  file: string
  line?: number
  cwe?: string
  kind: 'vuln' | 'regression' | 'clean'
  detector?: string
  description?: string
}

export interface FindingScored extends Finding {
  matchStatus: string
  isTP: boolean
  isFP: boolean
  isDuplicate: boolean
}

export interface PatchApplyResult {
  patchId: string
  findingId?: string
  file: string
  linesChanged: number
  gitApplyCheck: 'passed' | 'failed'
  syntaxValid?: boolean
  error?: string
}

export interface FullRunReport {
  runIndex: number
  model: string
  reasoningEffort: string
  wallTimeMs: number
  nodeSequence: string[]
  attempts: Record<string, number>
  degraded: string[]
  tokensPerAttempt: Array<{
    attempt: number
    input: number
    output: number
    cacheRead: number
    total: number
  }>
  tokensTotal: {
    input: number
    output: number
    cacheRead: number
    total: number
  }
  findings: FindingScored[]
  patchApplyResults: PatchApplyResult[]
  metrics: {
    totalLabels: number
    defectLabelsCount: number
    cleanLabelsCount: number
    tpCount: number
    fpCount: number
    duplicateCount: number
    fnCount: number
    precision: number
    recall: number
    logicRegressions: Record<string, 'caught' | 'missed'>
    selfCorrection: {
      triggered: boolean
      recovered: boolean
    }
  }
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
  patchQualityRateAvg: number
  selfCorrectionRate: number
  selfCorrectionRecoveryRate: number
  runs: FullRunReport[]
  markdownTable: string
}

export const loadLabels = (): GroundTruthLabel[] => {
  return JSON.parse(
    readFileSync(
      new URL('../tests/fixtures/vuln-repo.labels.json', import.meta.url),
      'utf8'
    )
  )
}

export const normalizeFindingFilePath = (filePath: string, repoDir?: string): string => {
  let norm = filePath.replace(/\\/g, '/')
  if (repoDir) {
    const normRepo = repoDir.replace(/\\/g, '/').replace(/\/$/, '')
    if (norm.startsWith(normRepo + '/')) {
      norm = norm.slice(normRepo.length + 1)
    }
  }
  norm = norm.replace(/^.*\/codesentinel-vuln-repo-[^/]+\//, '')
  return norm
}

export const scoreFindings = (
  confirmedFindings: Finding[],
  labels: GroundTruthLabel[],
  repoDir?: string
) => {
  const vulnLabels = labels.filter((l) => l.kind === 'vuln')
  const regressionLabels = labels.filter((l) => l.kind === 'regression')
  const cleanLabels = labels.filter((l) => l.kind === 'clean')
  const defectLabels = [...vulnLabels, ...regressionLabels]

  const matchedLabels = new Map<string, string>() // labelKey -> findingId
  const scoredFindings: FindingScored[] = []

  let tpCount = 0
  let fpCount = 0
  let duplicateCount = 0

  for (const finding of confirmedFindings) {
    const relFile = normalizeFindingFilePath(finding.file, repoDir)
    const normFile = relFile

    // 1. Clean file check -> strict FP
    const inCleanFile = cleanLabels.some((cl) =>
      normFile.endsWith(cl.file.replace(/\\/g, '/'))
    )
    if (inCleanFile) {
      fpCount++
      scoredFindings.push({
        ...finding,
        file: relFile,
        matchStatus: 'clean_file_false_positive',
        isTP: false,
        isFP: true,
        isDuplicate: false,
      })
      continue
    }

    // 2. Match against defect labels
    const findingLine = finding.startLine ?? (finding as any).line ?? 0
    let matchedLabel: GroundTruthLabel | undefined
    for (const label of defectLabels) {
      const targetFile = label.file.replace(/\\/g, '/')
      if (normFile.endsWith(targetFile)) {
        if (label.line === undefined || Math.abs(findingLine - label.line) <= 2) {
          matchedLabel = label
          break
        }
      }
    }

    if (!matchedLabel) {
      fpCount++
      scoredFindings.push({
        ...finding,
        file: relFile,
        matchStatus: 'unmatched',
        isTP: false,
        isFP: true,
        isDuplicate: false,
      })
      continue
    }

    const labelKey = `${matchedLabel.file}:${matchedLabel.line ?? 0} (${matchedLabel.kind}${matchedLabel.cwe ? `, ${matchedLabel.cwe}` : ''})`

    if (matchedLabels.has(labelKey)) {
      duplicateCount++
      scoredFindings.push({
        ...finding,
        file: relFile,
        matchStatus: `duplicate of ${labelKey}`,
        isTP: false,
        isFP: false,
        isDuplicate: true,
      })
    } else {
      matchedLabels.set(labelKey, finding.id)
      tpCount++
      scoredFindings.push({
        ...finding,
        file: relFile,
        matchStatus: labelKey,
        isTP: true,
        isFP: false,
        isDuplicate: false,
      })
    }
  }

  const fnCount = defectLabels.length - tpCount
  const precision = tpCount + fpCount > 0 ? tpCount / (tpCount + fpCount) : 1
  const recall = defectLabels.length > 0 ? tpCount / defectLabels.length : 0

  const logicRegressions: Record<string, 'caught' | 'missed'> = {
    'app/auth_logic.py:2': 'missed',
    'app/data_validator.py:2': 'missed',
    'web/permission.ts:5': 'missed',
  }

  for (const [key] of matchedLabels.entries()) {
    for (const logicKey of Object.keys(logicRegressions)) {
      if (key.startsWith(logicKey)) {
        logicRegressions[logicKey] = 'caught'
      }
    }
  }

  return {
    scoredFindings,
    tpCount,
    fpCount,
    duplicateCount,
    fnCount,
    precision,
    recall,
    logicRegressions,
    defectLabelsCount: defectLabels.length,
    cleanLabelsCount: cleanLabels.length,
  }
}

export const runSingleLiveEval = async (
  runIndex: number,
  forcedTimeout: boolean
): Promise<FullRunReport> => {
  console.log(`\n======================================================`)
  console.log(
    `[CodeSentinel:EvalFull] Starting Run ${runIndex} (forcedTimeout: ${forcedTimeout})`
  )
  console.log(`======================================================\n`)

  const repo = await makeRepo()
  const labels = loadLabels()

  const start = performance.now()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CodeSentinel_MODEL: 'openai-codex/gpt-5.6-luna',
    CodeSentinel_THINKING_LEVEL: 'medium',
    CodeSentinel_DEBUG_LLM: '1',
    CodeSentinel_ANALYZER_TIMEOUT_MS: forcedTimeout ? '1' : '60000',
  }

  const payload = JSON.stringify({
    platform: 'local',
    workspace: repo.dir,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
  })

  console.log(`[CodeSentinel:EvalFull] Workspace: ${repo.dir}`)
  console.log(
    `[CodeSentinel:EvalFull] Base SHA: ${repo.baseSha}, Head SHA: ${repo.headSha}`
  )

  let stdout = ''
  let stderr = ''
  const child = spawn(
    'npx',
    ['flue', 'run', 'review', '--target', 'node', '--input', payload],
    {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )

  child.stdout.on('data', (d) => {
    const str = d.toString()
    stdout += str
    process.stdout.write(str)
  })

  child.stderr.on('data', (d) => {
    const str = d.toString()
    stderr += str
    process.stderr.write(str)
  })

  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) resolve()
      else
        reject(new Error(`flue run review exited with code ${code}\nStderr: ${stderr}`))
    })
    child.on('error', reject)
  })

  const wallTimeMs = Math.round(performance.now() - start)
  console.log(
    `[CodeSentinel:EvalFull] Run ${runIndex} finished in ${(wallTimeMs / 1000).toFixed(1)}s`
  )

  // Parse token observation lines
  const combinedOutput = stdout + '\n' + stderr
  const tokensPerAttempt: FullRunReport['tokensPerAttempt'] = []
  let attemptCounter = 1

  for (const line of combinedOutput.split('\n')) {
    if (line.includes('[CodeSentinel:Tokens]')) {
      const braceIdx = line.indexOf('{')
      if (braceIdx !== -1) {
        try {
          const data = JSON.parse(line.slice(braceIdx))
          if (data.total || data.rawUsage?.totalTokens) {
            tokensPerAttempt.push({
              attempt: attemptCounter++,
              input: data.input ?? data.rawUsage?.input ?? 0,
              output: data.output ?? data.rawUsage?.output ?? 0,
              cacheRead: data.cache_read_input_tokens ?? data.rawUsage?.cacheRead ?? 0,
              total: data.total ?? data.rawUsage?.totalTokens ?? 0,
            })
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const tokensTotal = {
    input: tokensPerAttempt.reduce((acc, t) => acc + t.input, 0),
    output: tokensPerAttempt.reduce((acc, t) => acc + t.output, 0),
    cacheRead: tokensPerAttempt.reduce((acc, t) => acc + t.cacheRead, 0),
    total: tokensPerAttempt.reduce((acc, t) => acc + t.total, 0),
  }

  // Parse result json from the end of stdout
  let workflowResult: any = {}
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.findings || parsed.reviewed !== undefined) {
          workflowResult = parsed
          break
        }
      } catch {
        // continue searching
      }
    }
  }

  const confirmedFindings: Finding[] = workflowResult.findings ?? []
  const attempts: Record<string, number> = workflowResult.attempts ?? {}
  const degraded: string[] = workflowResult.degraded ?? []

  // Check patch validity in repo.dir
  const patchDir = path.join(repo.dir, '.CodeSentinel', 'patches')
  const patchApplyResults: PatchApplyResult[] = []

  try {
    const patchFiles = await fs.readdir(patchDir)
    for (const pf of patchFiles) {
      if (!pf.endsWith('.patch')) continue
      const patchPath = path.join(patchDir, pf)
      const diffContent = await fs.readFile(patchPath, 'utf8')
      const linesChanged = diffContent
        .split('\n')
        .filter((l) => l.startsWith('+') || l.startsWith('-'))
        .filter((l) => !l.startsWith('+++') && !l.startsWith('---')).length

      try {
        await execFileAsync('git', ['-C', repo.dir, 'apply', '--check', patchPath])
        let syntaxValid = true
        let syntaxError: string | undefined
        const match = diffContent.match(/^\+\+\+ b\/(.*)$/m)
        const relFile = match ? match[1].trim() : ''
        if (relFile) {
          const absFile = path.join(repo.dir, relFile)
          try {
            const rawContent = await fs.readFile(absFile, 'utf8')
            const { validateSyntax } = await import('../src/review/patch')
            const tmpClone = await fs.mkdtemp(
              path.join(os.tmpdir(), 'eval-syntax-check-')
            )
            try {
              await execFileAsync('git', ['clone', repo.dir, tmpClone])
              await execFileAsync('git', ['-C', tmpClone, 'apply', patchPath])
              const patchedContent = await fs.readFile(
                path.join(tmpClone, relFile),
                'utf8'
              )
              await validateSyntax(relFile, rawContent, patchedContent)
            } finally {
              await fs.rm(tmpClone, { recursive: true, force: true }).catch(() => {})
            }
          } catch (vErr: any) {
            syntaxValid = false
            syntaxError = vErr.message || String(vErr)
          }
        }

        patchApplyResults.push({
          patchId: pf.replace('.patch', ''),
          file: relFile,
          linesChanged,
          gitApplyCheck: syntaxValid ? 'passed' : 'failed',
          syntaxValid,
          error: syntaxError,
        })
      } catch (checkErr: any) {
        patchApplyResults.push({
          patchId: pf.replace('.patch', ''),
          file: '',
          linesChanged,
          gitApplyCheck: 'failed',
          syntaxValid: false,
          error: checkErr.message || String(checkErr),
        })
      }
    }
  } catch {
    // No patches directory
  }

  // Score findings against labels
  const scored = scoreFindings(confirmedFindings, labels, repo.dir)

  // Extract real ordered node sequence with cycles preserved
  const nodeSequence: string[] =
    Array.isArray(workflowResult.nodeSequence) && workflowResult.nodeSequence.length > 0
      ? workflowResult.nodeSequence
      : Object.keys(attempts)

  const selfCorrectionTriggered =
    (attempts['llm_triage'] ?? 0) > 1 || (attempts['static_analysis'] ?? 0) > 1
  const selfCorrectionRecovered =
    selfCorrectionTriggered &&
    !degraded.includes('llm_triage') &&
    !degraded.includes('static_analysis')

  const report: FullRunReport = {
    runIndex,
    model: 'openai-codex/gpt-5.6-luna',
    reasoningEffort: 'medium',
    wallTimeMs,
    nodeSequence,
    attempts,
    degraded,
    tokensPerAttempt,
    tokensTotal,
    findings: scored.scoredFindings,
    patchApplyResults,
    metrics: {
      totalLabels: labels.length,
      defectLabelsCount: scored.defectLabelsCount,
      cleanLabelsCount: scored.cleanLabelsCount,
      tpCount: scored.tpCount,
      fpCount: scored.fpCount,
      duplicateCount: scored.duplicateCount,
      fnCount: scored.fnCount,
      precision: scored.precision,
      recall: scored.recall,
      logicRegressions: scored.logicRegressions,
      selfCorrection: {
        triggered: selfCorrectionTriggered,
        recovered: selfCorrectionRecovered,
      },
    },
  }

  await repo.cleanup()
  return report
}

export const buildAggregateReport = (
  model: string,
  commitSha: string,
  runs: FullRunReport[]
): AggregateEvalReport => {
  const sortedLatencies = runs.map((r) => r.wallTimeMs).sort((a, b) => a - b)
  const p50LatencyMs = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] ?? 0
  const p95LatencyMs =
    sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] ??
    sortedLatencies[sortedLatencies.length - 1] ??
    0

  const totalTokensAvg =
    runs.reduce((acc, r) => acc + (r.tokensTotal.total ?? 0), 0) /
    Math.max(1, runs.length)
  const avgPrecision =
    runs.reduce((acc, r) => acc + r.metrics.precision, 0) / Math.max(1, runs.length)
  const avgRecall =
    runs.reduce((acc, r) => acc + r.metrics.recall, 0) / Math.max(1, runs.length)

  const patchQualityRateAvg =
    runs.reduce((acc, r) => {
      const valid = r.patchApplyResults.filter((p) => p.gitApplyCheck === 'passed').length
      const total = r.patchApplyResults.length
      return acc + (total > 0 ? valid / total : 1)
    }, 0) / Math.max(1, runs.length)

  const selfCorrectionCount = runs.filter(
    (r) => r.metrics.selfCorrection.triggered
  ).length
  const selfCorrectionRate = selfCorrectionCount / Math.max(1, runs.length)
  const recoveredCount = runs.filter((r) => r.metrics.selfCorrection.recovered).length
  const selfCorrectionRecoveryRate =
    selfCorrectionCount > 0 ? recoveredCount / selfCorrectionCount : 1

  const rows = runs
    .map(
      (r) =>
        `| Run ${r.runIndex} | ${r.metrics.tpCount} | ${r.metrics.fpCount} | ${r.metrics.fnCount} | ${(r.metrics.precision * 100).toFixed(1)}% | ${(r.metrics.recall * 100).toFixed(1)}% | ${r.metrics.duplicateCount} | ${(r.wallTimeMs / 1000).toFixed(1)}s |`
    )
    .join('\n')

  const markdownTable = `
| Run | TP | FP | FN | Precision | Recall | Duplicates | Latency |
|---|---|---|---|---|---|---|---|
${rows}
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
    console.log('To run the full-pipeline evaluation against openai-codex/gpt-5.6-luna:')
    console.log('  EVAL_FULL=1 npx tsx scripts/eval-full.ts')
    process.exit(0)
  }

  const resultsDir = path.join(process.cwd(), 'eval-results')
  await fs.mkdir(resultsDir, { recursive: true })

  // Run 1: Normal execution
  const run1 = await runSingleLiveEval(1, false)
  await fs.writeFile(
    path.join(resultsDir, 'full-run-1.json'),
    JSON.stringify(run1, null, 2)
  )
  console.log('[CodeSentinel:EvalFull] Saved eval-results/full-run-1.json')

  // Run 2: Forced analyzer timeout execution
  const run2 = await runSingleLiveEval(2, true)
  await fs.writeFile(
    path.join(resultsDir, 'full-run-2.json'),
    JSON.stringify(run2, null, 2)
  )
  console.log('[CodeSentinel:EvalFull] Saved eval-results/full-run-2.json')

  let commitSha = 'unknown'
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'])
    commitSha = stdout.trim()
  } catch {}

  const aggregate = buildAggregateReport('openai-codex/gpt-5.6-luna', commitSha, [
    run1,
    run2,
  ])
  await fs.writeFile(
    path.join(resultsDir, 'full-pipeline-summary.json'),
    JSON.stringify(aggregate, null, 2)
  )

  console.log('\n--- EVALUATION COMPLETE ---')
  console.log(aggregate.markdownTable)
}

if (
  process.argv[1]?.endsWith('eval-full.ts') ||
  process.argv[1]?.endsWith('eval-full.js') ||
  process.argv[1]?.includes('eval-full')
) {
  main().catch((err) => {
    console.error('[CodeSentinel:EvalFull] Fatal error:', err)
    process.exit(1)
  })
}
