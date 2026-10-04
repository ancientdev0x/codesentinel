import { afterEach, describe, expect, it } from 'vitest'
import { parsePrUrl } from '../../src/review/source'

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
