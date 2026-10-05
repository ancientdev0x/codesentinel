import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { makeRepo, type TestRepo } from '../tests/helpers/makeRepo'
import { runAstChecks } from '../src/review/ast/checks'
import { runStaticAnalysis } from '../src/review/analyzers'
import { resolveReviewConfig } from '../src/review/config'
import { getChangedFiles } from '../src/review/diff'
import type { Finding } from '../src/review/findings'

export interface LabelItem {
  file: string
  line?: number
  cwe?: string
  kind: 'vuln' | 'regression' | 'clean'
  detector?: string
}

export interface DetectorMetrics {
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
}

export interface EvalReport {
  timestamp?: string
  detectors: Record<string, DetectorMetrics>
  union: DetectorMetrics
  totalLabels: number
  deterministicLabelsCount: number
  cleanLabelsCount: number
  cleanFindingsCount: number
  markdownTable: string
}

export function matchFindingToLabel(finding: Finding, label: LabelItem): boolean {
  const normFinding = finding.file.replace(/\\/g, '/')
  const normLabel = label.file.replace(/\\/g, '/')
  if (!normFinding.endsWith(normLabel)) return false
  if (label.kind === 'clean') return false

  const labelLine = label.line ?? 0
  const lineMatches = Math.abs(finding.startLine - labelLine) <= 2

  if (!lineMatches) return false

  if (label.kind === 'regression') {
    if (label.detector === 'tsc' && finding.source === 'tsc') return true
    if (
      label.detector === 'ruff' &&
      (finding.source === 'ruff' || finding.ruleId.startsWith('F'))
    ) {
      return true
    }
    return finding.source === 'tsc' || finding.source === 'ruff'
  }

  if (label.cwe && finding.cwe) {
    return finding.cwe === label.cwe
  }

  return true
}

export async function runDeterministicEval(
  opts: {
    workspace?: string
    labelsPath?: string
    sandbox?: 'auto' | 'docker' | 'host'
  } = {}
): Promise<EvalReport> {
  let repo: TestRepo | undefined
  let workspace = opts.workspace
  let baseSha = 'HEAD~1'
  let headSha = 'HEAD'

  if (!workspace) {
    repo = await makeRepo()
    workspace = repo.dir
    baseSha = repo.baseSha
    headSha = repo.headSha
  }

  try {
    const labelsFile =
      opts.labelsPath ||
      path.join(process.cwd(), 'tests', 'fixtures', 'vuln-repo.labels.json')
    const rawLabels = await fsp.readFile(labelsFile, 'utf8')
    const labels: LabelItem[] = JSON.parse(rawLabels)

    const deterministicLabels = labels.filter(
      (l) => l.kind !== 'clean' && l.detector !== 'llm'
    )
    const cleanLabels = labels.filter((l) => l.kind === 'clean')
    const cleanFileNames = cleanLabels.map((l) => l.file)

    const cfg = resolveReviewConfig(
      {
        platform: 'local',
        workspace,
        baseSha,
        headSha,
        sandbox: opts.sandbox || 'auto',
        staticAnalysis: true,
        astChecks: true,
      },
      process.env
    )

    const { files: changedFiles } = await getChangedFiles(cfg)

    // 1. Run AST checks
    const astFindings = runAstChecks(changedFiles)

    // 2. Run static analysis (Bandit, Ruff, tsc)
    const staticResult = await runStaticAnalysis(
      cfg,
      changedFiles.map((f) => f.fileName),
      ['bandit', 'ruff', 'tsc']
    )
    const staticFindings = staticResult.findings

    const allFindings = [...astFindings, ...staticFindings]

    // Calculate metrics per detector
    const detectorNames = ['ast-grep', 'bandit', 'ruff', 'tsc']
    const detectorMetrics: Record<string, DetectorMetrics> = {}

    for (const det of detectorNames) {
      const detFindings = allFindings.filter((f) => f.source === det)
      const detTargetLabels = deterministicLabels.filter((l) => {
        return l.detector ? l.detector.includes(det) : false
      })

      let tp = 0
      for (const label of detTargetLabels) {
        const hasMatch = detFindings.some((f) => matchFindingToLabel(f, label))
        if (hasMatch) tp++
      }

      const fn = detTargetLabels.length - tp
      const fp = detFindings.filter((f) => {
        const norm = f.file.replace(/\\/g, '/')
        return cleanFileNames.some((c) => norm.endsWith(c))
      }).length

      const precision = tp + fp > 0 ? tp / (tp + fp) : 1.0
      const recall = detTargetLabels.length > 0 ? tp / detTargetLabels.length : 1.0

      detectorMetrics[det] = {
        tp,
        fp,
        fn,
        precision: Number(precision.toFixed(3)),
        recall: Number(recall.toFixed(3)),
      }
    }

    // Union metrics (evaluated across all deterministic labels)
    let unionTp = 0
    for (const label of deterministicLabels) {
      const hasMatch = allFindings.some((f) => matchFindingToLabel(f, label))
      if (hasMatch) unionTp++
    }
    const cleanFindingsCount = allFindings.filter((f) => {
      const norm = f.file.replace(/\\/g, '/')
      return cleanFileNames.some((c) => norm.endsWith(c))
    }).length
    const unionFp = cleanFindingsCount
    const unionFn = deterministicLabels.length - unionTp
    const unionPrecision = unionTp + unionFp > 0 ? unionTp / (unionTp + unionFp) : 1.0
    const unionRecall =
      deterministicLabels.length > 0 ? unionTp / deterministicLabels.length : 1.0

    const unionMetrics: DetectorMetrics = {
      tp: unionTp,
      fp: unionFp,
      fn: unionFn,
      precision: Number(unionPrecision.toFixed(3)),
      recall: Number(unionRecall.toFixed(3)),
    }

    // Format markdown table
    const rows = [
      '| Detector | TP | FP | FN | Precision | Recall |',
      '|---|---|---|---|---|---|',
      ...detectorNames.map((d) => {
        const m = detectorMetrics[d]
        return `| ${d} | ${m.tp} | ${m.fp} | ${m.fn} | ${(m.precision * 100).toFixed(1)}% | ${(m.recall * 100).toFixed(1)}% |`
      }),
      `| **Union** | **${unionMetrics.tp}** | **${unionMetrics.fp}** | **${unionMetrics.fn}** | **${(unionMetrics.precision * 100).toFixed(1)}%** | **${(unionMetrics.recall * 100).toFixed(1)}%** |`,
    ]
    const markdownTable = rows.join('\n')

    const report: EvalReport = {
      detectors: detectorMetrics,
      union: unionMetrics,
      totalLabels: labels.length,
      deterministicLabelsCount: deterministicLabels.length,
      cleanLabelsCount: cleanLabels.length,
      cleanFindingsCount,
      markdownTable,
    }

    // Save eval-results/deterministic.json only when EVAL_WRITE=1
    if (process.env.EVAL_WRITE === '1') {
      try {
        const outDir = path.join(process.cwd(), 'eval-results')
        await fsp.mkdir(outDir, { recursive: true })
        await fsp.writeFile(
          path.join(outDir, 'deterministic.json'),
          JSON.stringify(report, null, 2) + '\n',
          'utf8'
        )
      } catch {
        // ignore write errors in constrained environments
      }
    }

    return report
  } finally {
    if (repo) {
      await repo.cleanup()
    }
  }
}
