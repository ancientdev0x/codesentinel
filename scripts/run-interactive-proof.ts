import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { makeRepo } from '../tests/helpers/makeRepo.ts'

const execFileAsync = promisify(execFile)

console.log('[CodeSentinel:InteractiveProof] Initializing test repo...')
const repo = await makeRepo()

try {
  // Let us stage a change in the repo: app/calc.py with eval(expr)
  // And let's check git status in repo
  await execFileAsync('git', ['diff', '-U0', repo.baseSha, repo.headSha], {
    cwd: repo.dir,
  })
  console.log('[CodeSentinel:InteractiveProof] Repo base..head diff ready')

  const payload = JSON.stringify({
    platform: 'local',
    workspace: repo.dir,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
    hitlMode: 'terminal',
  })

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CodeSentinel_MODEL: 'openai-codex/gpt-5.6-luna',
    CodeSentinel_THINKING_LEVEL: 'medium',
    CodeSentinel_DEBUG_LLM: '1',
  }

  console.log(
    '[CodeSentinel:InteractiveProof] Spawning flue run review with piped "a" (apply)...'
  )
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

  const checkPrompt = (str: string) => {
    if (str.includes('[a]pply / [r]eject / [e]dit / [q]uit:')) {
      console.log(
        '\n>>> [CodeSentinel:InteractiveProof] Detected prompt, sending "a" (approve) <<<\n'
      )
      child.stdin.write('a\n')
    }
  }

  child.stdout.on('data', (d) => {
    const str = d.toString()
    fullStdout += str
    process.stdout.write(str)
    checkPrompt(str)
  })

  child.stderr.on('data', (d) => {
    const str = d.toString()
    fullStderr += str
    process.stderr.write(str)
    checkPrompt(str)
  })

  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(`flue run review exited with code ${code}\nStderr: ${fullStderr}`)
        )
    })
  })

  // Assert .CodeSentinel/patches/<id>.patch created
  const patchesDir = path.join(repo.dir, '.CodeSentinel', 'patches')
  let patchFiles: string[] = []
  try {
    patchFiles = await fs.readdir(patchesDir)
  } catch {
    patchFiles = []
  }

  console.log('\n[CodeSentinel:InteractiveProof] Created patch files:', patchFiles)
  if (patchFiles.length === 0) {
    throw new Error('No .CodeSentinel/patches/<id>.patch files were created!')
  }

  // Parse result JSON
  const allLines = (fullStdout + '\n' + fullStderr).split('\n').map((l) => l.trim())
  const rawLine = allLines.filter((l) => l.includes('{"reviewed":')).pop()

  if (!rawLine) {
    throw new Error('Failed to find workflow result JSON in stdout/stderr')
  }
  const jsonStart = rawLine.indexOf('{"reviewed":')
  const jsonEnd = rawLine.lastIndexOf('}')
  const jsonStr = rawLine.slice(jsonStart, jsonEnd + 1)
  const result = JSON.parse(jsonStr)
  console.log(
    '[CodeSentinel:InteractiveProof] Workflow result applied patches:',
    result.applied
  )

  if (!result.applied || result.applied.length === 0) {
    throw new Error('No patches were applied in workflow result!')
  }

  console.log(
    '\n[CodeSentinel:InteractiveProof] SUCCESS: Patches created and applied cleanly via interactive terminal mode!'
  )
} finally {
  await repo.cleanup()
}
