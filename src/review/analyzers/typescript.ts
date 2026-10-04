import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { type Finding, findingId } from '../findings'
import type { RunResult, RunSpec } from '../../sandbox/run'
import { runIsolated } from '../../sandbox/run'
import { normalizeFilePath } from './bandit'

export const TSC_OUTPUT_REGEX = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/

/**
 * Parses raw tsc --pretty false output into Finding models.
 */
export const parseTscOutput = (
  rawOutput: string,
  workspace: string,
  changedFiles?: string[]
): Finding[] => {
  const findings: Finding[] = []
  const normalizedChanged = changedFiles
    ? new Set(changedFiles.map((f) => normalizeFilePath(f, workspace)))
    : undefined

  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim()
    const match = trimmed.match(TSC_OUTPUT_REGEX)
    if (!match) continue

    const rawFile = match[1]
    const lineNum = Number.parseInt(match[2], 10)
    const ruleId = match[4]
    const message = match[5]

    const file = isAbsolute(rawFile)
      ? relative(workspace, rawFile)
      : normalizeFilePath(rawFile, workspace)

    // Keep only errors belonging to changed files if changedFiles is provided
    if (normalizedChanged && !normalizedChanged.has(file)) {
      continue
    }

    const finding: Finding = {
      id: findingId({
        source: 'tsc',
        ruleId,
        file,
        startLine: lineNum,
      }),
      source: 'tsc',
      ruleId,
      severity: 'high',
      confidence: 'high',
      file,
      startLine: lineNum,
      endLine: lineNum,
      message: `[regression] TS error ${ruleId}: ${message}`,
      rationale: 'regression',
      status: 'candidate',
    }
    findings.push(finding)
  }

  return findings
}

/**
 * Runs TypeScript typecheck (`tsc --noEmit`) on the host with timeout isolation.
 *
 * NOTE: TypeScript type checking runs on the host (not inside the Docker image)
 * because it requires the repository's local tsconfig.json and installed `node_modules`
 * type definitions which are not baked into the Python analyzer container.
 */
export const runTsc = async (
  files: string[],
  workspace: string,
  timeoutMs = 120_000
): Promise<{ findings: Finding[]; runResult?: RunResult }> => {
  const tsFiles = files.filter(
    (f) =>
      f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mts') || f.endsWith('.cts')
  )

  if (tsFiles.length === 0) {
    return { findings: [] }
  }

  const tsconfigPath = join(workspace, 'tsconfig.json')
  if (!existsSync(tsconfigPath)) {
    return { findings: [] }
  }

  const spec: RunSpec = {
    tool: 'tsc',
    cmd: 'npx',
    args: ['--no-install', 'tsc', '--noEmit', '-p', tsconfigPath, '--pretty', 'false'],
    cwd: workspace,
    timeoutMs,
    okExitCodes: [0, 1, 2], // 1 and 2 indicate type check errors
  }

  const runResult = await runIsolated(spec, 'host')

  if (runResult.status !== 'ok') {
    return { findings: [], runResult }
  }

  const rawOutput = `${runResult.stdout}\n${runResult.stderr}`
  const findings = parseTscOutput(rawOutput, workspace, tsFiles)

  return { findings, runResult }
}
