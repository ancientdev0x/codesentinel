import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRepo, type TestRepo } from './makeRepo'

const execFileAsync = promisify(execFile)

describe('makeRepo helper', () => {
  let repo: TestRepo

  beforeAll(async () => {
    repo = await makeRepo()
  })

  afterAll(async () => {
    if (repo) {
      await repo.cleanup()
    }
  })

  it('creates valid baseSha and headSha', () => {
    expect(repo.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(repo.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(repo.baseSha).not.toBe(repo.headSha)
  })

  it('lists all expected seeded vulnerable and clean files in git diff base...head', async () => {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', `${repo.baseSha}...${repo.headSha}`],
      { cwd: repo.dir }
    )
    const changedFiles = stdout.trim().split('\n')

    const expectedFiles = [
      'app/run.py',
      'app/store.py',
      'app/config.py',
      'app/db.py',
      'app/calc.py',
      'app/yaml_load.py',
      'app/regress.py',
      'web/exec.ts',
      'web/eval.ts',
      'web/broken.ts',
      'app/clean_math.py',
      'web/clean_format.ts',
      'web/clean_sanitize.ts',
    ]

    for (const expected of expectedFiles) {
      expect(changedFiles).toContain(expected)
    }
    expect(changedFiles).toHaveLength(expectedFiles.length)
  })
})
