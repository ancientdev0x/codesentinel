import { execFile, execFileSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Octokit } from 'octokit'

const execFileAsync = promisify(execFile)

export const PATCH_COMMAND_REGEX = /^\/codesentinel\s+(apply|reject)\s+([0-9a-f]{8})\b/im

export const AUTHORIZED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

export interface ParsedPatchCommand {
  action: 'apply' | 'reject'
  patchId: string
}

export interface ExtractedPatch {
  patchId: string
  findingId?: string
  sha: string
  traceId?: string
  diff: string
}

export interface HandlePatchCommandOptions {
  octokit: Octokit
  owner: string
  repo: string
  pullNumber: number
  commentId: number
  commentBody: string
  authorAssociation: string
  authorLogin: string
  workspace?: string
  isReviewComment?: boolean
}

export interface PatchCommandResult {
  handled: boolean
  action?: 'apply' | 'reject'
  patchId?: string
  commitSha?: string
  error?: string
  reply?: string
}

export function parsePatchCommand(body: string): ParsedPatchCommand | null {
  const match = body.match(PATCH_COMMAND_REGEX)
  if (!match) return null
  return {
    action: match[1].toLowerCase() as 'apply' | 'reject',
    patchId: match[2].toLowerCase(),
  }
}

export function isAuthorizedAuthor(association: string): boolean {
  return AUTHORIZED_ASSOCIATIONS.has(association?.toUpperCase())
}

export function extractPatchFromComment(commentBody: string): ExtractedPatch | null {
  const idMatch = commentBody.match(
    /<!--\s*codesentinel:patch\s+[^>]*\bid=([0-9a-f]{8})\b/i
  )
  const shaMatch = commentBody.match(
    /<!--\s*codesentinel:patch\s+[^>]*\bsha=([\w.-]+)\b/i
  )
  if (!idMatch || !shaMatch) return null

  const diffRegex = /```diff\r?\n([\s\S]*?)\r?\n```/
  const diffMatch = commentBody.match(diffRegex)
  if (!diffMatch) return null

  const traceMatch = commentBody.match(
    /<!--\s*codesentinel:patch\s+[^>]*\btrace=([^\s>]+)\b/i
  )
  const findingMatch = commentBody.match(
    /<!--\s*codesentinel:patch\s+[^>]*\bfinding=([^\s>]+)\b/i
  )

  return {
    patchId: idMatch[1].toLowerCase(),
    findingId: findingMatch ? findingMatch[1] : undefined,
    sha: shaMatch[1],
    traceId: traceMatch ? traceMatch[1] : undefined,
    diff: diffMatch[1],
  }
}

export async function recordRejectedPatch(
  workspace: string,
  patchId: string,
  user: string,
  findingId?: string
): Promise<void> {
  const dir = path.join(workspace, '.CodeSentinel')
  await fsp.mkdir(dir, { recursive: true })
  const storePath = path.join(dir, 'rejected-patches.json')

  let rejected: Record<
    string,
    { user: string; timestamp: string; patchId?: string; findingId?: string }
  > = {}
  try {
    const raw = await fsp.readFile(storePath, 'utf8')
    rejected = JSON.parse(raw)
  } catch {
    // initialize empty
  }

  const now = new Date().toISOString()
  rejected[patchId] = { user, timestamp: now, findingId }
  if (findingId) {
    rejected[findingId] = { user, timestamp: now, patchId }
  }
  await fsp.writeFile(storePath, JSON.stringify(rejected, null, 2), 'utf8')
}

export async function getRejectedIds(workspace: string): Promise<Set<string>> {
  const storePath = path.join(workspace, '.CodeSentinel', 'rejected-patches.json')
  try {
    const raw = await fsp.readFile(storePath, 'utf8')
    const rejected = JSON.parse(raw)
    return new Set(Object.keys(rejected))
  } catch {
    return new Set()
  }
}

export async function isPatchRejected(workspace: string, id: string): Promise<boolean> {
  const storePath = path.join(workspace, '.CodeSentinel', 'rejected-patches.json')
  try {
    const raw = await fsp.readFile(storePath, 'utf8')
    const rejected = JSON.parse(raw)
    return Boolean(rejected[id])
  } catch {
    return false
  }
}

/**
 * Handles /codesentinel apply <id> and /codesentinel reject <id> commands.
 */
export async function handlePatchCommand(
  opts: HandlePatchCommandOptions
): Promise<PatchCommandResult> {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    commentId,
    commentBody,
    authorAssociation,
    authorLogin,
    workspace = process.cwd(),
    isReviewComment = false,
  } = opts

  const parsed = parsePatchCommand(commentBody)
  if (!parsed) {
    return { handled: false, error: 'Not a patch command' }
  }

  const replyComment = async (text: string) => {
    return octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: text,
    })
  }

  const addReaction = async (content: '+1' | '-1') => {
    try {
      if (isReviewComment) {
        await octokit.rest.reactions.createForPullRequestReviewComment({
          owner,
          repo,
          comment_id: commentId,
          content,
        })
      } else {
        await octokit.rest.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: commentId,
          content,
        })
      }
    } catch {
      // ignore reaction failures
    }
  }

  // 1. Authorization check
  if (!isAuthorizedAuthor(authorAssociation)) {
    const msg =
      'You are not authorized to apply or reject CodeSentinel patches (requires OWNER, MEMBER, or COLLABORATOR).'
    await replyComment(msg)
    return {
      handled: true,
      action: parsed.action,
      patchId: parsed.patchId,
      error: 'unauthorized',
      reply: msg,
    }
  }

  // 2. Fetch PR info
  const pr = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  })
  const currentHeadSha = pr.data.head.sha
  const isFork =
    Boolean(pr.data.head?.repo?.fork) ||
    Boolean(
      pr.data.head?.repo?.full_name &&
      pr.data.base?.repo?.full_name &&
      pr.data.head.repo.full_name !== pr.data.base.repo.full_name
    )

  // 3. Find patch comment
  const reviewComments = await octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number: pullNumber,
  })

  const targetComment = reviewComments.data.find((c) => {
    return c.body?.includes(`<!-- codesentinel:patch id=${parsed.patchId}`) || false
  })

  if (!targetComment) {
    const msg = `Could not find any patch comment matching ID \`${parsed.patchId}\`.`
    await replyComment(msg)
    return {
      handled: true,
      action: parsed.action,
      patchId: parsed.patchId,
      error: 'patch_not_found',
      reply: msg,
    }
  }

  // Security check: verify patch comment author is the bot
  const botLogin = targetComment.user?.login || ''
  const isBot =
    botLogin === 'github-actions[bot]' ||
    botLogin.endsWith('[bot]') ||
    targetComment.user?.type === 'Bot'
  if (!isBot) {
    const msg = 'Security error: patch comment was not authored by github-actions[bot].'
    await replyComment(msg)
    return {
      handled: true,
      action: parsed.action,
      patchId: parsed.patchId,
      error: 'untrusted_patch_author',
      reply: msg,
    }
  }

  const patchData = extractPatchFromComment(targetComment.body)
  if (!patchData) {
    const msg = `Failed to parse patch diff for ID \`${parsed.patchId}\`.`
    await replyComment(msg)
    return {
      handled: true,
      action: parsed.action,
      patchId: parsed.patchId,
      error: 'invalid_patch_data',
      reply: msg,
    }
  }

  // 4. Stale check
  if (patchData.sha !== currentHeadSha) {
    const msg = `Patch \`${parsed.patchId}\` is stale (generated against ${patchData.sha.slice(0, 7)}, current head is ${currentHeadSha.slice(0, 7)}). Please re-run review.`
    await replyComment(msg)
    return {
      handled: true,
      action: parsed.action,
      patchId: parsed.patchId,
      error: 'stale_patch',
      reply: msg,
    }
  }

  // 5. Action: APPLY
  if (parsed.action === 'apply') {
    if (isFork) {
      const msg = 'Cannot apply patches to fork pull requests automatically.'
      await replyComment(msg)
      return {
        handled: true,
        action: 'apply',
        patchId: parsed.patchId,
        error: 'fork_pr',
        reply: msg,
      }
    }

    // Security check: prevent directory traversal or absolute paths in diff
    const hasTraversal = patchData.diff.includes('../') || patchData.diff.includes('..\\')
    if (hasTraversal) {
      const msg = 'Security violation: patch diff contains path traversal.'
      await replyComment(msg)
      return {
        handled: true,
        action: 'apply',
        patchId: parsed.patchId,
        error: 'path_traversal',
        reply: msg,
      }
    }

    try {
      // Run git apply --check first
      execFileSync('git', ['apply', '--check', '-'], {
        cwd: workspace,
        input: patchData.diff,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Run git apply
      execFileSync('git', ['apply', '-'], {
        cwd: workspace,
        input: patchData.diff,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Commit
      const commitMsg = `fix: apply CodeSentinel patch ${parsed.patchId}\n\nCo-authored-by: ${authorLogin} <${authorLogin}@users.noreply.github.com>`
      await execFileAsync('git', ['add', '.'], { cwd: workspace })
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: workspace })

      const { stdout: commitShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: workspace,
      })
      const commitSha = commitShaOut.trim()

      // Push to head branch
      const headRef = pr.data.head.ref
      await execFileAsync('git', ['push', 'origin', `HEAD:${headRef}`], {
        cwd: workspace,
      })

      await addReaction('+1')
      const msg = `Applied patch \`${parsed.patchId}\` in commit \`${commitSha}\`.`
      await replyComment(msg)

      return {
        handled: true,
        action: 'apply',
        patchId: parsed.patchId,
        commitSha,
        reply: msg,
      }
    } catch (err) {
      const msg = `Failed to apply patch \`${parsed.patchId}\`: ${err instanceof Error ? err.message : String(err)}`
      await replyComment(msg)
      return {
        handled: true,
        action: 'apply',
        patchId: parsed.patchId,
        error: msg,
        reply: msg,
      }
    }
  }

  // 6. Action: REJECT
  if (parsed.action === 'reject') {
    await addReaction('-1')

    // Append rejection notice to the patch comment
    const updatedBody = `${targetComment.body}\n\n> ❌ **Rejected by @${authorLogin}**`
    await octokit.rest.pulls.updateReviewComment({
      owner,
      repo,
      comment_id: targetComment.id,
      body: updatedBody,
    })

    await recordRejectedPatch(workspace, parsed.patchId, authorLogin, patchData.findingId)

    const msg = `Patch \`${parsed.patchId}\` marked as rejected.`
    await replyComment(msg)

    return {
      handled: true,
      action: 'reject',
      patchId: parsed.patchId,
      reply: msg,
    }
  }

  return { handled: false }
}
