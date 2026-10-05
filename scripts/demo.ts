import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { promisify } from 'node:util'
import { runAstChecks } from '../src/review/ast/checks'
import { runStaticAnalysis } from '../src/review/analyzers'
import { resolveReviewConfig } from '../src/review/config'
import { getChangedFiles } from '../src/review/diff'
import { dedupeFindings, type Finding } from '../src/review/findings'

const execFileAsync = promisify(execFile)

export interface DemoResult {
  findings: Finding[]
  files: string[]
  durationMs: number
}

export async function runDemo(opts: { quiet?: boolean } = {}): Promise<DemoResult> {
  const startTime = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'codesentinel-demo-'))
  await chmod(dir, 0o777)

  try {
    const runGit = async (...args: string[]) => {
      return execFileAsync('git', args, { cwd: dir })
    }

    // 1. Create base commit
    await mkdir(join(dir, 'app'), { recursive: true })
    await mkdir(join(dir, 'web'), { recursive: true })

    await writeFile(
      join(dir, 'app', 'db.py'),
      `def get_user(conn, uid: str):\n    return conn.execute("SELECT * FROM users WHERE id = ?", (uid,))\n`
    )
    await writeFile(
      join(dir, 'web', 'config.ts'),
      `export function getSecretToken(): string {\n  return process.env.API_KEY || ''\n}\n`
    )
    await writeFile(
      join(dir, 'app', 'clean.py'),
      `def calculate_total(prices: list[float]) -> float:\n    return sum(prices)\n`
    )

    await runGit('init', '-b', 'main')
    await runGit('config', 'user.name', 'CodeSentinel Demo')
    await runGit('config', 'user.email', 'demo@codesentinel.local')
    await runGit('config', 'commit.gpgsign', 'false')
    await runGit('add', '.')
    await runGit('commit', '-m', 'Initial baseline commit')
    const { stdout: baseShaOut } = await runGit('rev-parse', 'HEAD')
    const baseSha = baseShaOut.trim()

    // 2. Create head commit (sample PR with 1 SQL injection, 1 hardcoded secret, 1 clean file edit)
    await writeFile(
      join(dir, 'app', 'db.py'),
      `def get_user(conn, uid: str):\n    return conn.execute(f"SELECT * FROM users WHERE id = '{uid}'")\n`
    )
    await writeFile(
      join(dir, 'web', 'config.ts'),
      `export function getSecretToken(): string {\n  const apiKey = 'sk-live-sample-token-12345'\n  return apiKey\n}\n`
    )
    await writeFile(
      join(dir, 'app', 'clean.py'),
      `def calculate_total(prices: list[float]) -> float:\n    """Calculate total price safely."""\n    return sum(prices)\n`
    )

    await execFileAsync('chmod', ['-R', 'a+rX', dir])
    await runGit('add', '.')
    await runGit('commit', '-m', 'Add user lookup and token helper (sample PR)')
    const { stdout: headShaOut } = await runGit('rev-parse', 'HEAD')
    const headSha = headShaOut.trim()

    // 3. Resolve review config without requiring API keys, with host fallback
    const cfg = resolveReviewConfig(
      {
        platform: 'local',
        workspace: dir,
        baseSha,
        headSha,
        sandbox:
          (process.env.CodeSentinel_SANDBOX as 'auto' | 'docker' | 'host') || 'auto',
      },
      process.env
    )

    const { files: changedFiles } = await getChangedFiles(cfg)

    // 4. Run AST checks and static analysis
    const astFindings = runAstChecks(changedFiles, dir)
    const staticResult = await runStaticAnalysis(
      cfg,
      changedFiles.map((f) => f.fileName)
    )

    const allFindings = dedupeFindings([...astFindings, ...staticResult.findings])
    const durationMs = Date.now() - startTime

    const relFiles = changedFiles.map((f) =>
      path.relative(dir, f.fileName).replace(/\\/g, '/')
    )

    if (!opts.quiet) {
      printDemoOutput({
        findings: allFindings,
        changedFiles: relFiles,
        durationMs,
        staticReports: staticResult.reports,
      })
    }

    return {
      findings: allFindings,
      files: relFiles,
      durationMs,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function printDemoOutput(data: {
  findings: Finding[]
  changedFiles: string[]
  durationMs: number
  staticReports: { tool: string; status: string; findings: number }[]
}): void {
  const reset = '\x1b[0m'
  const bold = '\x1b[1m'
  const red = '\x1b[31m'
  const green = '\x1b[32m'
  const yellow = '\x1b[33m'
  const cyan = '\x1b[36m'
  const dim = '\x1b[2m'

  console.log()
  console.log(`${bold}${cyan}🛡️  CodeSentinel Demo Review${reset}`)
  console.log(
    `${dim}Analyzing 3 changed files in sample PR (offline deterministic mode)...${reset}`
  )
  console.log()

  console.log(`${bold}Review Findings Summary:${reset}`)
  console.log('─'.repeat(100))
  console.log(
    `${bold}${'File'.padEnd(20)} ${'Line'.padEnd(6)} ${'Severity'.padEnd(10)} ${'Rule / CWE'.padEnd(24)} ${'Message'}${reset}`
  )
  console.log('─'.repeat(100))

  const reportedFiles = new Set<string>()

  for (const f of data.findings) {
    reportedFiles.add(f.file)
    const sevColor =
      f.severity === 'critical' ? red : f.severity === 'high' ? red : yellow
    const sevStr = `${sevColor}${f.severity.toUpperCase().padEnd(10)}${reset}`
    const ruleStr = `${f.ruleId}${f.cwe ? ` (${f.cwe})` : ''}`.padEnd(24)
    const truncatedMsg =
      f.message.length > 38 ? `${f.message.slice(0, 35)}...` : f.message

    console.log(
      `${f.file.padEnd(20)} ${String(f.startLine).padEnd(6)} ${sevStr} ${ruleStr} ${truncatedMsg}`
    )
  }

  for (const file of data.changedFiles) {
    if (!reportedFiles.has(file)) {
      console.log(
        `${file.padEnd(20)} ${'-'.padEnd(6)} ${green}${'CLEAN'.padEnd(10)}${reset} ${'-'.padEnd(24)} ${green}No security issues detected${reset}`
      )
    }
  }

  console.log('─'.repeat(100))
  console.log()

  console.log(`${bold}Analyzers:${reset}`)
  console.log(
    `  ${green}✔${reset} ast-grep (AST): in-process structural analysis (${data.findings.filter((f) => f.source === 'ast-grep').length} findings)`
  )
  for (const r of data.staticReports) {
    console.log(
      `  ${green}✔${reset} ${r.tool} (static): ${r.status} (${r.findings} findings)`
    )
  }
  console.log()

  console.log(
    `${bold}${green}✔ Demo review completed in ${(data.durationMs / 1000).toFixed(2)}s with exit code 0.${reset}`
  )
  console.log()
}

if (!process.env.VITEST) {
  runDemo()
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
