import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Octokit } from 'octokit'
import { assertSafeRef } from './diff'

const execFileAsync = promisify(execFile)

export interface PrRef {
  host: string
  owner: string
  repo: string
  number: number
}

export interface MaterializedPr {
  workspace: string
  baseSha: string
  headSha: string
  ref: PrRef
  cleanup(): Promise<void>
}

const SAFE_IDENTIFIER = /^[\w.-]+$/

const isSafeIdentifier = (id: string): boolean => {
  return SAFE_IDENTIFIER.test(id) && !id.includes('..')
}

/**
 * Parses a GitHub PR URL or shorthand reference into a structured PrRef.
 *
 * Supported formats:
 * - https://github.com/owner/repo/pull/123
 * - https://github.com/owner/repo/pull/123/files
 * - https://github.com/owner/repo/pull/123/commits
 * - owner/repo#123
 *
 * For GitHub Enterprise Server (GHES), the host from process.env.GITHUB_API_URL
 * is also accepted.
 */
export const parsePrUrl = (raw: string): PrRef => {
  const trimmed = raw?.trim()
  if (!trimmed) {
    throw new Error('PR reference cannot be empty')
  }

  // 1. Shorthand format: owner/repo#123
  const shortMatch = /^([\w.-]+)\/([\w.-]+)#(-?\d+)$/.exec(trimmed)
  if (shortMatch) {
    const [, owner, repo, numStr] = shortMatch
    if (!isSafeIdentifier(owner) || !isSafeIdentifier(repo)) {
      throw new Error(`Invalid owner or repository name: ${owner}/${repo}`)
    }
    const number = Number.parseInt(numStr, 10)
    if (number <= 0) {
      throw new Error(`PR number must be positive, got ${number}`)
    }

    let host = 'github.com'
    if (process.env.GITHUB_API_URL) {
      try {
        const parsedHost = new URL(process.env.GITHUB_API_URL).hostname
        if (parsedHost !== 'api.github.com') {
          host = parsedHost
        }
      } catch {
        // fallback to github.com
      }
    }
    return { host, owner, repo, number }
  }

  // 2. Full URL format
  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmed)
  } catch {
    throw new Error(`Invalid PR URL format: "${trimmed}"`)
  }

  const allowedHosts = new Set(['github.com', 'www.github.com'])
  if (process.env.GITHUB_API_URL) {
    try {
      allowedHosts.add(new URL(process.env.GITHUB_API_URL).hostname)
    } catch {
      // ignore
    }
  }

  if (!allowedHosts.has(parsedUrl.hostname.toLowerCase())) {
    throw new Error(
      `Unsupported host: "${parsedUrl.hostname}". Only GitHub hosts are supported.`
    )
  }

  // Path format: /owner/repo/pull/123(/files|/commits|...)
  const segments = parsedUrl.pathname.split('/').filter(Boolean)
  if (segments.length < 4 || segments[2] !== 'pull') {
    throw new Error(
      `Invalid GitHub PR URL path: "${parsedUrl.pathname}". Expected /owner/repo/pull/<number>`
    )
  }

  const [owner, repo, , numStr] = segments

  if (!isSafeIdentifier(owner) || !isSafeIdentifier(repo)) {
    throw new Error(`Invalid owner or repository name: ${owner}/${repo}`)
  }

  const number = Number.parseInt(numStr, 10)
  if (Number.isNaN(number) || number <= 0 || String(number) !== numStr) {
    throw new Error(`PR number must be a positive integer, got "${numStr}"`)
  }

  return {
    host: parsedUrl.hostname.toLowerCase(),
    owner,
    repo,
    number,
  }
}

/**
 * Fetches PR head and base refs from GitHub (or local mock), creates a shallow
 * clone in an isolated temporary worktree, and detaches HEAD to headSha.
 *
 * Auth token is passed via `http.extraheader` rather than inside URL, and is never logged.
 * Caller MUST call `materialized.cleanup()` inside a try/finally block.
 */
export const materializePr = async (
  ref: PrRef,
  token?: string
): Promise<MaterializedPr> => {
  const baseUrl = process.env.GITHUB_API_URL
  const octokit = new Octokit({
    auth: token || undefined,
    baseUrl: baseUrl || undefined,
  })

  const { data: pr } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
  })

  const baseSha = assertSafeRef(pr.base.sha, 'base.sha')
  const headSha = assertSafeRef(pr.head.sha, 'head.sha')
  const baseRef = pr.base.ref ? assertSafeRef(pr.base.ref, 'base.ref') : undefined

  // Clone URL from base repository (or default https)
  const cloneUrl =
    pr.base.repo?.clone_url || `https://${ref.host}/${ref.owner}/${ref.repo}.git`

  const workspace = await mkdtemp(join(tmpdir(), 'codesentinel-pr-'))

  const runGit = async (
    args: string[],
    extraArgs: string[] = []
  ): Promise<{ stdout: string; stderr: string }> => {
    return execFileAsync('git', [...extraArgs, ...args], {
      cwd: workspace,
      timeout: 120_000,
    })
  }

  // Pass token as extraheader, never embed in url or log
  // GitHub HTTP smart protocol requires Basic auth (x-access-token:<token>)
  const authArgs = token
    ? [
        '-c',
        `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      ]
    : []

  try {
    await runGit(['init'])
    await runGit(['remote', 'add', 'origin', cloneUrl])

    const prRefSpec = `refs/pull/${ref.number}/head`
    try {
      await runGit(
        ['fetch', '--depth=200', '--no-tags', 'origin', baseSha, prRefSpec],
        authArgs
      )
    } catch {
      if (baseRef) {
        await runGit(
          [
            'fetch',
            '--depth=200',
            '--no-tags',
            'origin',
            `refs/heads/${baseRef}`,
            prRefSpec,
          ],
          authArgs
        )
      } else {
        await runGit(['fetch', '--depth=200', '--no-tags', 'origin', prRefSpec], authArgs)
      }
    }

    await runGit(['checkout', '--detach', headSha])

    // Verify merge-base exists; if shallow history severed it, deepen and retry once
    let hasMergeBase = false
    try {
      await runGit(['merge-base', baseSha, headSha])
      hasMergeBase = true
    } catch {
      hasMergeBase = false
    }

    if (!hasMergeBase) {
      try {
        await runGit(['fetch', '--deepen=500', 'origin'], authArgs)
        await runGit(['merge-base', baseSha, headSha])
      } catch {
        // Deepen retry completed
      }
    }
  } catch (err) {
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  const cleanup = async (): Promise<void> => {
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }

  return {
    workspace,
    baseSha,
    headSha,
    ref,
    cleanup,
  }
}
