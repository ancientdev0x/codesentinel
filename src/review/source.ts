export interface PrRef {
  host: string
  owner: string
  repo: string
  number: number
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
        host = new URL(process.env.GITHUB_API_URL).hostname
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
