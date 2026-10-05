import { execFile } from 'node:child_process'
import { chmod, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TestRepo {
  dir: string
  baseSha: string
  headSha: string
  cleanup: () => Promise<void>
}

/**
 * Creates an isolated git repository in a temp directory with a base commit
 * containing clean files and a head commit containing vulnerable / regression edits.
 */
export const makeRepo = async (): Promise<TestRepo> => {
  const dir = await mkdtemp(join(tmpdir(), 'codesentinel-vuln-repo-'))
  await chmod(dir, 0o777)
  const fixtureBase = join(__dirname, '../fixtures/vuln-repo/base')
  const fixtureHead = join(__dirname, '../fixtures/vuln-repo/head')

  // 1. Copy base version
  await cp(fixtureBase, dir, { recursive: true })

  const runGit = async (...args: string[]) => {
    return execFileAsync('git', args, { cwd: dir })
  }

  // 2. Initialize git repository and create base commit
  await runGit('init', '-b', 'main')
  await runGit('config', 'user.name', 'Test Runner')
  await runGit('config', 'user.email', 'test@example.com')
  await runGit('config', 'commit.gpgsign', 'false')
  await runGit('add', '.')
  await runGit('commit', '-m', 'base commit')
  const { stdout: baseShaOut } = await runGit('rev-parse', 'HEAD')
  const baseSha = baseShaOut.trim()

  // 3. Apply head version on top
  await cp(fixtureHead, dir, { recursive: true })
  await execFileAsync('chmod', ['-R', 'a+rX', dir])
  await runGit('add', '.')
  await runGit('commit', '-m', 'head commit with vulnerabilities')
  const { stdout: headShaOut } = await runGit('rev-parse', 'HEAD')
  const headSha = headShaOut.trim()

  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  return { dir, baseSha, headSha, cleanup }
}
