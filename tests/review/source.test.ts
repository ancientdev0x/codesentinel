import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const pullsGetMock = vi.fn()
vi.mock('octokit', () => {
  return {
    Octokit: class MockOctokit {
      rest = {
        pulls: {
          get: (...args: unknown[]) => pullsGetMock(...args),
        },
      }
    },
  }
})

import { materializePr, parsePrUrl } from '../../src/review/source'

const execFileAsync = promisify(execFile)

describe('parsePrUrl', () => {
  const originalGithubApiUrl = process.env.GITHUB_API_URL

  afterEach(() => {
    if (originalGithubApiUrl !== undefined) {
      process.env.GITHUB_API_URL = originalGithubApiUrl
    } else {
      delete process.env.GITHUB_API_URL
    }
  })

  it('parses standard GitHub PR URL', () => {
    const res = parsePrUrl('https://github.com/ancientdev0x/CodeSentinel/pull/42')
    expect(res).toEqual({
      host: 'github.com',
      owner: 'ancientdev0x',
      repo: 'CodeSentinel',
      number: 42,
    })
  })

  it('parses PR URL with /files suffix', () => {
    const res = parsePrUrl('https://github.com/octocat/Hello-World/pull/1347/files')
    expect(res).toEqual({
      host: 'github.com',
      owner: 'octocat',
      repo: 'Hello-World',
      number: 1347,
    })
  })

  it('parses PR URL with /commits suffix, trailing slash, queries, and fragments', () => {
    const res = parsePrUrl(
      'https://github.com/octocat/Hello-World/pull/99/commits/?diff=split#discussion_r123'
    )
    expect(res).toEqual({
      host: 'github.com',
      owner: 'octocat',
      repo: 'Hello-World',
      number: 99,
    })
  })

  it('parses shorthand owner/repo#number format', () => {
    const res = parsePrUrl('facebook/react#28000')
    expect(res).toEqual({
      host: 'github.com',
      owner: 'facebook',
      repo: 'react',
      number: 28000,
    })
  })

  it('rejects path traversal attempts with ../', () => {
    expect(() => parsePrUrl('https://github.com/../repo/pull/12')).toThrow()
    expect(() => parsePrUrl('../repo#12')).toThrow()
    expect(() => parsePrUrl('owner/../pull/12')).toThrow()
  })

  it('rejects invalid names with spaces or illegal characters', () => {
    expect(() => parsePrUrl('https://github.com/bad owner/repo/pull/12')).toThrow()
    expect(() => parsePrUrl('owner/bad repo#12')).toThrow()
    expect(() => parsePrUrl('')).toThrow()
  })

  it('rejects non-GitHub hosts by default', () => {
    delete process.env.GITHUB_API_URL
    expect(() => parsePrUrl('https://gitlab.com/owner/repo/pull/12')).toThrow(
      /Unsupported host/
    )
    expect(() => parsePrUrl('https://bitbucket.org/owner/repo/pull/12')).toThrow(
      /Unsupported host/
    )
  })

  it('accepts custom enterprise host when GITHUB_API_URL is configured', () => {
    process.env.GITHUB_API_URL = 'https://ghe.mycorp.internal/api/v3'
    const res = parsePrUrl('https://ghe.mycorp.internal/core/service/pull/101')
    expect(res).toEqual({
      host: 'ghe.mycorp.internal',
      owner: 'core',
      repo: 'service',
      number: 101,
    })
  })

  it('rejects non-positive PR numbers', () => {
    expect(() => parsePrUrl('https://github.com/o/r/pull/0')).toThrow(/positive/)
    expect(() => parsePrUrl('https://github.com/o/r/pull/-5')).toThrow()
    expect(() => parsePrUrl('o/r#0')).toThrow(/positive/)
    expect(() => parsePrUrl('o/r#-10')).toThrow(/positive/)
  })
})

describe('materializePr', () => {
  let bareDir: string
  let workDir: string
  let baseSha: string
  let headSha: string

  afterEach(async () => {
    vi.restoreAllMocks()
    if (bareDir) await rm(bareDir, { recursive: true, force: true }).catch(() => {})
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  it('clones bare origin, detaches to headSha, and validates merge-base with deleted fork fallback', async () => {
    // 1. Setup local bare repository and work repo
    bareDir = await mkdtemp(join(tmpdir(), 'codesentinel-test-bare-'))
    await execFileAsync('git', ['init', '--bare'], { cwd: bareDir })

    workDir = await mkdtemp(join(tmpdir(), 'codesentinel-test-work-'))
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: workDir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workDir })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: workDir,
    })
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: workDir })

    // Base commit
    await writeFile(join(workDir, 'file.txt'), 'base content\n')
    await execFileAsync('git', ['add', '.'], { cwd: workDir })
    await execFileAsync('git', ['commit', '-m', 'base commit'], { cwd: workDir })
    const { stdout: bSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: workDir,
    })
    baseSha = bSha.trim()

    // Head commit
    await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: workDir })
    await writeFile(join(workDir, 'file.txt'), 'head content\n')
    await execFileAsync('git', ['add', '.'], { cwd: workDir })
    await execFileAsync('git', ['commit', '-m', 'feature commit'], { cwd: workDir })
    const { stdout: hSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: workDir,
    })
    headSha = hSha.trim()

    // Push main and refs/pull/1/head into bareDir
    await execFileAsync(
      'git',
      ['push', bareDir, 'main:main', 'feature:refs/pull/1/head'],
      { cwd: workDir }
    )

    // 2. Mock Octokit pulls.get with deleted fork (head.repo === null)
    pullsGetMock.mockResolvedValue({
      data: {
        base: {
          sha: baseSha,
          ref: 'main',
          repo: { clone_url: `file://${bareDir}` },
        },
        head: {
          sha: headSha,
          ref: 'feature',
          repo: null, // fork deleted!
        },
      },
    })

    // 3. Run materializePr
    const materialized = await materializePr(
      { host: 'github.com', owner: 'testowner', repo: 'testrepo', number: 1 },
      'test-token'
    )

    try {
      expect(materialized.baseSha).toBe(baseSha)
      expect(materialized.headSha).toBe(headSha)

      // Verify headSha is checked out in workspace
      const { stdout: currentHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: materialized.workspace,
      })
      expect(currentHead.trim()).toBe(headSha)

      // Verify git merge-base base head succeeds
      const { stdout: mergeBase } = await execFileAsync(
        'git',
        ['merge-base', baseSha, headSha],
        { cwd: materialized.workspace }
      )
      expect(mergeBase.trim()).toBe(baseSha)
    } finally {
      await materialized.cleanup()
      // Verify workspace was removed
      await expect(stat(materialized.workspace)).rejects.toThrow()
    }
  })
})
