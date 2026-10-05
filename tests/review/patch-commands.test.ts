import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractPatchFromComment,
  getRejectedIds,
  handlePatchCommand,
  isAuthorizedAuthor,
  isPatchRejected,
  parsePatchCommand,
} from '../../src/review/patch-commands'

const execFileAsync = promisify(execFile)

describe('GitHub Patch Commands (E5.4)', () => {
  let tmpRepo: string

  beforeEach(async () => {
    tmpRepo = await fsp.mkdtemp(path.join(os.tmpdir(), 'patch-cmd-test-'))
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmpRepo })
    await execFileAsync('git', ['config', 'user.name', 'Test Bot'], { cwd: tmpRepo })
    await execFileAsync('git', ['config', 'user.email', 'bot@example.com'], {
      cwd: tmpRepo,
    })
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpRepo })
    await fsp.writeFile(path.join(tmpRepo, 'file.txt'), 'line 1\nline 2\n', 'utf8')
    await execFileAsync('git', ['add', '.'], { cwd: tmpRepo })
    await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: tmpRepo })
  })

  afterEach(async () => {
    await fsp.rm(tmpRepo, { recursive: true, force: true }).catch(() => {})
  })

  it('parses /codesentinel apply and reject commands', () => {
    expect(parsePatchCommand('/codesentinel apply a1b2c3d4')).toEqual({
      action: 'apply',
      patchId: 'a1b2c3d4',
    })
    expect(parsePatchCommand('/CodeSentinel REJECT DeadBeef')).toEqual({
      action: 'reject',
      patchId: 'deadbeef',
    })
    expect(parsePatchCommand('/codesentinel review')).toBeNull()
    expect(parsePatchCommand('just a comment')).toBeNull()
  })

  it('authorizes only OWNER, MEMBER, and COLLABORATOR', () => {
    expect(isAuthorizedAuthor('OWNER')).toBe(true)
    expect(isAuthorizedAuthor('MEMBER')).toBe(true)
    expect(isAuthorizedAuthor('COLLABORATOR')).toBe(true)
    expect(isAuthorizedAuthor('CONTRIBUTOR')).toBe(false)
    expect(isAuthorizedAuthor('FIRST_TIME_CONTRIBUTOR')).toBe(false)
    expect(isAuthorizedAuthor('NONE')).toBe(false)
  })

  it('extracts patch diff and metadata from review comment body', () => {
    const commentBody = `
**[HIGH]** Insecure eval

\`\`\`suggestion
return safeParse(input)
\`\`\`

<details><summary>Patch a1b2c3d4 · +1 −1</summary>

\`\`\`diff
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-line 1
+line 1 updated
\`\`\`

<!-- codesentinel:patch id=a1b2c3d4 sha=head123456 trace=run-789 -->
</details>

Reply \`/codesentinel apply a1b2c3d4\` or \`/codesentinel reject a1b2c3d4\`.
`
    const extracted = extractPatchFromComment(commentBody)
    expect(extracted).toEqual({
      patchId: 'a1b2c3d4',
      sha: 'head123456',
      traceId: 'run-789',
      diff: `--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-line 1\n+line 1 updated`,
    })
  })

  it('rejects commands from unauthorized authors', async () => {
    const mockReply = vi.fn().mockResolvedValue({})
    const mockOctokit: any = {
      rest: {
        issues: { createComment: mockReply },
      },
    }

    const res = await handlePatchCommand({
      octokit: mockOctokit,
      owner: 'org',
      repo: 'repo',
      pullNumber: 1,
      commentId: 10,
      commentBody: '/codesentinel apply a1b2c3d4',
      authorAssociation: 'NONE',
      authorLogin: 'untrusted-user',
      workspace: tmpRepo,
    })

    expect(res.handled).toBe(true)
    expect(res.error).toBe('unauthorized')
    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('not authorized'),
      })
    )
  })

  it('rejects commands when patch comment was not authored by a bot', async () => {
    const mockReply = vi.fn().mockResolvedValue({})
    const mockOctokit: any = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: { head: { sha: 'head123', ref: 'feature' } },
          }),
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 100,
                user: { login: 'malicious-attacker', type: 'User' },
                body: `<!-- codesentinel:patch id=a1b2c3d4 sha=head123 -->\n\`\`\`diff\n+evil\n\`\`\``,
              },
            ],
          }),
        },
        issues: { createComment: mockReply },
      },
    }

    const res = await handlePatchCommand({
      octokit: mockOctokit,
      owner: 'org',
      repo: 'repo',
      pullNumber: 1,
      commentId: 10,
      commentBody: '/codesentinel apply a1b2c3d4',
      authorAssociation: 'OWNER',
      authorLogin: 'admin',
      workspace: tmpRepo,
    })

    expect(res.handled).toBe(true)
    expect(res.error).toBe('untrusted_patch_author')
    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('Security error'),
      })
    )
  })

  it('rejects commands when the patch SHA is stale', async () => {
    const mockReply = vi.fn().mockResolvedValue({})
    const mockOctokit: any = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: { head: { sha: 'current-fresh-sha' } },
          }),
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 100,
                user: { login: 'github-actions[bot]', type: 'Bot' },
                body: `<!-- codesentinel:patch id=a1b2c3d4 sha=old-stale-sha -->\n\`\`\`diff\n--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-line 1\n+line 1 updated\n\`\`\``,
              },
            ],
          }),
        },
        issues: { createComment: mockReply },
      },
    }

    const res = await handlePatchCommand({
      octokit: mockOctokit,
      owner: 'org',
      repo: 'repo',
      pullNumber: 1,
      commentId: 10,
      commentBody: '/codesentinel apply a1b2c3d4',
      authorAssociation: 'COLLABORATOR',
      authorLogin: 'dev',
      workspace: tmpRepo,
    })

    expect(res.handled).toBe(true)
    expect(res.error).toBe('stale_patch')
    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('is stale'),
      })
    )
  })

  it('refuses to apply patches to fork pull requests automatically', async () => {
    const mockReply = vi.fn().mockResolvedValue({})
    const mockOctokit: any = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              head: {
                sha: 'head123',
                repo: { fork: true, full_name: 'contributor/repo' },
              },
              base: { repo: { full_name: 'upstream/repo' } },
            },
          }),
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 100,
                user: { login: 'github-actions[bot]', type: 'Bot' },
                body: `<!-- codesentinel:patch id=a1b2c3d4 sha=head123 -->\n\`\`\`diff\n--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-line 1\n+line 1 updated\n\`\`\``,
              },
            ],
          }),
        },
        issues: { createComment: mockReply },
      },
    }

    const res = await handlePatchCommand({
      octokit: mockOctokit,
      owner: 'upstream',
      repo: 'repo',
      pullNumber: 1,
      commentId: 10,
      commentBody: '/codesentinel apply a1b2c3d4',
      authorAssociation: 'OWNER',
      authorLogin: 'maintainer',
      workspace: tmpRepo,
    })

    expect(res.handled).toBe(true)
    expect(res.error).toBe('fork_pr')
    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('Cannot apply patches to fork pull requests'),
      })
    )
  })

  it('applies patch, commits with co-author trailer, and pushes in happy path', async () => {
    const { stdout: headShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: tmpRepo,
    })
    const currentSha = headShaOut.trim()

    // Add a fake remote origin so git push succeeds
    const bareRemote = await fsp.mkdtemp(path.join(os.tmpdir(), 'bare-remote-'))
    await execFileAsync('git', ['init', '--bare'], { cwd: bareRemote })
    await execFileAsync('git', ['remote', 'add', 'origin', bareRemote], { cwd: tmpRepo })
    await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: tmpRepo })

    const diff = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
-line 1
+line 1 patched
 line 2
`

    const mockReply = vi.fn().mockResolvedValue({})
    const mockReaction = vi.fn().mockResolvedValue({})
    const mockOctokit: any = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              head: {
                sha: currentSha,
                ref: 'main',
                repo: { fork: false, full_name: 'org/repo' },
              },
              base: { repo: { full_name: 'org/repo' } },
            },
          }),
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 100,
                user: { login: 'github-actions[bot]', type: 'Bot' },
                body: `<!-- codesentinel:patch id=a1b2c3d4 sha=${currentSha} -->\n\`\`\`diff\n${diff}\n\`\`\``,
              },
            ],
          }),
        },
        issues: { createComment: mockReply },
        reactions: { createForIssueComment: mockReaction },
      },
    }

    try {
      const res = await handlePatchCommand({
        octokit: mockOctokit,
        owner: 'org',
        repo: 'repo',
        pullNumber: 42,
        commentId: 50,
        commentBody: '/codesentinel apply a1b2c3d4',
        authorAssociation: 'COLLABORATOR',
        authorLogin: 'reviewer-jane',
        workspace: tmpRepo,
      })

      expect(res.handled).toBe(true)
      expect(res.action).toBe('apply')
      expect(res.commitSha).toBeDefined()
      expect(mockReaction).toHaveBeenCalledWith(
        expect.objectContaining({ content: '+1' })
      )
      expect(mockReply).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(`Applied patch \`a1b2c3d4\``),
        })
      )

      // Verify git file content was updated
      const updatedContent = await fsp.readFile(path.join(tmpRepo, 'file.txt'), 'utf8')
      expect(updatedContent).toContain('line 1 patched')

      // Verify commit message trailer
      const { stdout: logOut } = await execFileAsync(
        'git',
        ['log', '-1', '--pretty=%B'],
        { cwd: tmpRepo }
      )
      expect(logOut).toContain('fix: apply CodeSentinel patch a1b2c3d4')
      expect(logOut).toContain('Co-authored-by: reviewer-jane')
    } finally {
      await fsp.rm(bareRemote, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('rejects patch, updates review comment, and records rejection memory', async () => {
    const mockReply = vi.fn().mockResolvedValue({})
    const mockReaction = vi.fn().mockResolvedValue({})
    const mockUpdateComment = vi.fn().mockResolvedValue({})

    const initialCommentBody = `<!-- codesentinel:patch id=b2c3d4e5 finding=find12345678 sha=some-sha -->\n\`\`\`diff\n...\n\`\`\``

    const mockOctokit: any = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: { head: { sha: 'some-sha' } },
          }),
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 200,
                user: { login: 'github-actions[bot]', type: 'Bot' },
                body: initialCommentBody,
              },
            ],
          }),
          updateReviewComment: mockUpdateComment,
        },
        issues: { createComment: mockReply },
        reactions: { createForIssueComment: mockReaction },
      },
    }

    const res = await handlePatchCommand({
      octokit: mockOctokit,
      owner: 'org',
      repo: 'repo',
      pullNumber: 10,
      commentId: 25,
      commentBody: '/codesentinel reject b2c3d4e5',
      authorAssociation: 'MEMBER',
      authorLogin: 'approver-bob',
      workspace: tmpRepo,
    })

    expect(res.handled).toBe(true)
    expect(res.action).toBe('reject')
    expect(mockReaction).toHaveBeenCalledWith(expect.objectContaining({ content: '-1' }))
    expect(mockUpdateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 200,
        body: expect.stringContaining('Rejected by @approver-bob'),
      })
    )
    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('marked as rejected'),
      })
    )

    // Verify rejection memory file
    const isRejected = await isPatchRejected(tmpRepo, 'b2c3d4e5')
    expect(isRejected).toBe(true)
    const isFindingRejected = await isPatchRejected(tmpRepo, 'find12345678')
    expect(isFindingRejected).toBe(true)
    const rejectedSet = await getRejectedIds(tmpRepo)
    expect(rejectedSet.has('b2c3d4e5')).toBe(true)
    expect(rejectedSet.has('find12345678')).toBe(true)
  })
})
