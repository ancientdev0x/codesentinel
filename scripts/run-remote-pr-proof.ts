import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Obtain GITHUB_TOKEN from gh CLI to avoid unauthenticated GitHub API rate limits
let token = process.env.GITHUB_TOKEN
if (!token) {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'])
    token = stdout.trim()
  } catch {
    // If gh auth token fails, proceed without token
  }
}

const prUrl = 'https://github.com/ancientdev0x/codesentinel-demo/pull/1'
console.log(`[CodeSentinel:RemotePrProof] Reviewing remote PR: ${prUrl}`)

const payload = JSON.stringify({
  platform: 'local',
  prUrl,
})

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...(token ? { GITHUB_TOKEN: token } : {}),
  CodeSentinel_MODEL: 'openai-codex/gpt-5.6-luna',
  CodeSentinel_THINKING_LEVEL: 'medium',
  CodeSentinel_DEBUG_LLM: '1',
}

let fullStdout = ''
let fullStderr = ''

const child = spawn(
  'npx',
  ['flue', 'run', 'review', '--target', 'node', '--input', payload],
  {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  }
)

child.stdout.on('data', (d) => {
  const str = d.toString()
  fullStdout += str
  process.stdout.write(str)
})

child.stderr.on('data', (d) => {
  const str = d.toString()
  fullStderr += str
  process.stderr.write(str)
})

await new Promise<void>((resolve, reject) => {
  child.on('close', (code) => {
    if (code === 0) resolve()
    else
      reject(new Error(`flue run review exited with code ${code}\nStderr: ${fullStderr}`))
  })
})

const combined = `${fullStdout}\n${fullStderr}`

// Parse final JSON from stdout to assert stages
let resultJson: any = null
const jsonMatch = fullStdout.match(/\{[\s\S]*"reviewed":[\s\S]*\}/)
if (jsonMatch) {
  try {
    resultJson = JSON.parse(jsonMatch[0])
  } catch {
    // ignore
  }
}

const requiredStages = [
  'ingest',
  'extract_ast',
  'static_analysis',
  'llm_triage',
  'validate',
  'report',
]

console.log('\n[CodeSentinel:RemotePrProof] Verifying 6 pipeline stages...')
const stagesRun = resultJson?.nodeSequence ?? []
console.log('[CodeSentinel:RemotePrProof] Stages in nodeSequence:', stagesRun)

for (const stage of requiredStages) {
  if (
    !stagesRun.includes(stage) &&
    !combined.includes(`node.${stage}`) &&
    !combined.includes(`stage: '${stage}'`)
  ) {
    throw new Error(
      `Required pipeline stage "${stage}" was not detected in run output or nodeSequence`
    )
  }
}

console.log('[CodeSentinel:RemotePrProof] All 6 pipeline stages verified!')

// Scrub local paths for clean public proof
const scrubbedOutput = combined
  .replace(new RegExp(process.cwd(), 'g'), '.')
  .replace(/\/tmp\/codesentinel-pr-[^/\s]+/g, '<tmp>/pr-workspace')
  .replace(/\/home\/[a-zA-Z0-9._-]+/g, '<user_home>')

const logPath = path.join(process.cwd(), 'eval-results', 'remote-pr-run.log')
await fs.writeFile(logPath, scrubbedOutput)
console.log(`[CodeSentinel:RemotePrProof] Output saved to: ${logPath}`)
