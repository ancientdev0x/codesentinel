import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { Octokit } from 'octokit'
import { FORMATTING, formatSummary } from '../common/formatting/summary'
import type { ReviewConfig } from '../review/config'

export interface ReviewCommentInput {
  filePath: string
  comment: string
  startLine?: number
  endLine?: number
}

/** Posts review output to GitHub (CI) or to a local file (dev). */
export interface Reporter {
  postReviewComment: (input: ReviewCommentInput) => Promise<string | undefined>
  postSummary: (
    comment: string,
    analyzerRows?: import('../common/formatting/summary').AnalyzerReportRow[]
  ) => Promise<string | undefined>
}

/** Make a workspace-absolute path relative to the repo root for the GitHub API. */
const toRepoPath = (workspace: string, filePath: string): string =>
  isAbsolute(filePath) ? relative(workspace, filePath) : filePath

const createGithubReporter = (cfg: ReviewConfig): Reporter => {
  const target = cfg.github
  if (!target) {
    throw new Error(
      'GitHub reporter requires owner/repo/prNumber. Is this running on a PR?'
    )
  }
  const octokit = new Octokit({ auth: target.token })
  const { owner, repo, prNumber } = target

  const resolveCommitId = async (): Promise<string> => {
    if (cfg.headSha) return cfg.headSha
    const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
    return pr.data.head.sha
  }

  return {
    postReviewComment: async ({ filePath, comment, startLine, endLine }) => {
      const path = toRepoPath(cfg.workspace, filePath)
      const commit_id = await resolveCommitId()
      const line = endLine ?? startLine
      try {
        const multiLine = startLine && endLine && startLine !== endLine
        try {
          const { data } = await octokit.rest.pulls.createReviewComment({
            owner,
            repo,
            pull_number: prNumber,
            commit_id,
            body: comment,
            path,
            line,
            ...(multiLine
              ? { start_line: startLine, start_side: 'RIGHT', side: 'RIGHT' }
              : {}),
          })
          return data.html_url
        } catch (error) {
          if (multiLine) {
            // If multi-line comment failed because start_line was not in hunk, retry on single line
            const { data } = await octokit.rest.pulls.createReviewComment({
              owner,
              repo,
              pull_number: prNumber,
              commit_id,
              body: comment,
              path,
              line,
            })
            return data.html_url
          }
          throw error
        }
      } catch (error) {
        // Surface the error to the model so it can adjust the line/path.
        throw new Error(
          `Failed to post review comment on ${path}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },

    postSummary: async (comment, analyzerRows) => {
      const body = formatSummary(comment, analyzerRows)
      const { data: existing } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
      })
      const prior = existing.find((c) => c.body?.includes(FORMATTING.SIGN_OFF))
      if (prior) {
        const { data } = await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: prior.id,
          body,
        })
        return data.html_url
      }
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      })
      return data.html_url
    },
  }
}

// One report file per process so inline comments (posted by the agent's
// reporter, created in the agent initializer) and the summary (posted by the
// workflow's reporter) land in the SAME file, even though they come from two
// separate createReporter() calls.
const LOCAL_RUN_TIMESTAMP = new Date().toISOString().replace(/:/g, '-')

const createLocalReporter = (cfg: ReviewConfig): Reporter => {
  const reviewDir = join(cfg.workspace, '.CodeSentinel', 'review')
  const reviewFile = join(reviewDir, `local_${LOCAL_RUN_TIMESTAMP}.md`)

  const ensureDir = async (): Promise<void> => {
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, '.gitignore'), '*').catch(() => {})
  }

  return {
    postReviewComment: async ({ filePath, comment, startLine, endLine }) => {
      await ensureDir()
      const path = toRepoPath(cfg.workspace, filePath)
      const loc = startLine
        ? `:${startLine}${endLine && endLine !== startLine ? `-${endLine}` : ''}`
        : ''
      await appendFile(reviewFile, `### ${path}${loc}\n\n${comment}\n\n`)
      return `Comment written to ${reviewFile}`
    },
    postSummary: async (comment, analyzerRows) => {
      await ensureDir()
      await appendFile(reviewFile, `${formatSummary(comment, analyzerRows)}\n`)
      return `Summary written to ${reviewFile}`
    },
  }
}

/**
 * Wraps a primary reporter with a fallback reporter. If the primary throws an HTTP 403 Forbidden
 * (e.g. read-only token), it logs a warning once and switches all future operations to the fallback.
 */
export const fallbackOnForbidden = (primary: Reporter, fallback: Reporter): Reporter => {
  let switched = false

  const isForbidden = (err: unknown): boolean => {
    if (!err) return false
    const msg = String(err)
    if (
      msg.includes('403') ||
      msg.includes('Forbidden') ||
      msg.includes('Resource not accessible')
    ) {
      return true
    }
    if (typeof err === 'object' && err !== null) {
      if ('status' in err && (err as { status: number }).status === 403) return true
      if ('cause' in err && isForbidden((err as { cause: unknown }).cause)) return true
    }
    return false
  }

  return {
    postReviewComment: async (input) => {
      if (switched) {
        return fallback.postReviewComment(input)
      }
      try {
        return await primary.postReviewComment(input)
      } catch (err) {
        if (isForbidden(err)) {
          switched = true
          console.warn(
            '[CodeSentinel] GITHUB_TOKEN does not have write access to post review comments (HTTP 403). Falling back to local file output.'
          )
          return fallback.postReviewComment(input)
        }
        throw err
      }
    },
    postSummary: async (comment, analyzerRows) => {
      if (switched) {
        return fallback.postSummary(comment, analyzerRows)
      }
      try {
        return await primary.postSummary(comment, analyzerRows)
      } catch (err) {
        if (isForbidden(err)) {
          switched = true
          console.warn(
            '[CodeSentinel] GITHUB_TOKEN does not have write access to post summary (HTTP 403). Falling back to local file output.'
          )
          return fallback.postSummary(comment, analyzerRows)
        }
        throw err
      }
    },
  }
}

export const createReporter = (cfg: ReviewConfig): Reporter => {
  // On the github platform without PR context (owner/repo/prNumber), degrade to
  // local file output with a visible warning rather than crashing the review.
  if (cfg.platform === 'github' && !cfg.github) {
    console.error(
      '[CodeSentinel] platform is "github" but no PR context was found (owner/repo/prNumber). ' +
        'Falling back to local file output. Set GITHUB_TOKEN + PR metadata to post on the PR.'
    )
    return createLocalReporter(cfg)
  }
  if (cfg.platform === 'github') {
    const github = createGithubReporter(cfg)
    const local = createLocalReporter(cfg)
    return fallbackOnForbidden(github, local)
  }
  return createLocalReporter(cfg)
}
