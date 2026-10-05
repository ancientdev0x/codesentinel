# E1 — PR URL ingestion

**Unlocks (C1):** "ingesting git diffs **and PR URLs**".
**Effort:** ~1 day. **Prereqs:** E0.3, E0.4.

## Current state
- `src/review/diff.ts:41-55` diffs `base...head` or `--cached` inside an existing checkout.
- `bin/CodeSentinel.mjs:233` only POSTs `{platform, workspace}`, and the CLI has no URL argument.
- `src/channels/github.ts:124-137` has a `get_pull_request_diff`, but it only serves the mention agent.

## Goal
```
CodeSentinel review --pr https://github.com/owner/repo/pull/123   # any PR, any machine
```
The command fetches the PR into a temporary worktree and runs the full pipeline on it. When `GITHUB_TOKEN` has write access, comments go to the PR. Otherwise they go to the local report file.

Design choice: **fetch the refs, don't just download the `.diff`**. The AST stage (E2), the analyzers (E3) and the agent's `read`/`grep` tools all need real files on disk, so a diff-only ingest would starve every later stage.

---

## E1.1 `parsePrUrl` [x]
**File:** `src/review/source.ts` (new)
```ts
export interface PrRef { host: string; owner: string; repo: string; number: number }
export const parsePrUrl = (url: string): PrRef => {
  // Accept https://github.com/o/r/pull/12, with optional /files, /commits, trailing slash, query, or #fragment.
  // Also accept the short form o/r#12.
  // Reject anything else with a clear error. Validate owner/repo against /^[\w.-]+$/ —
  // these values end up in git argv.
}
```
- **Tests:** valid forms, the `/files` suffix, the short form, and rejection of `../`, spaces, non-github hosts (unless `GITHUB_API_URL` is set, for GHES support), and `number<=0`.
- **Accept:** tests pass.

## E1.2 Materialize the PR on disk [x]
**File:** `src/review/source.ts`
```ts
export interface MaterializedPr { workspace: string; baseSha: string; headSha: string; ref: PrRef; cleanup(): Promise<void> }
export const materializePr = async (ref: PrRef, token?: string): Promise<MaterializedPr>
```
Steps:
1. Call Octokit `pulls.get` to get `base.sha`, `head.sha`, `base.repo.clone_url` and `head.repo.clone_url`. `head.repo` can be a fork, and it can be `null` if the fork was deleted. In that case, fall back to `refs/pull/N/head` on the base repo.
2. Create a tmp dir with `mkdtemp(join(tmpdir(), 'codesentinel-pr-'))`.
3. Run git through `execFile` with no shell, the existing `assertSafeRef` pattern from `diff.ts`, and a timeout of 120s:
   - `git init`
   - `git remote add origin <clone_url>`
   - `git fetch --depth=200 --no-tags origin <base.sha> refs/pull/N/head`
   - `git checkout --detach <head.sha>`
   - If the merge-base is missing because the history is shallow, deepen with `--deepen=500` and retry once.
4. Pass the token as an auth header rather than embedding it in the URL:
   `git -c http.extraheader="AUTHORIZATION: bearer $TOKEN"`. **Never log it.**
5. `cleanup()` removes the dir with `rm(dir, {recursive:true, force:true})`. Callers must use try/finally.

- **Tests:** mock Octokit, and use a local bare repo as "origin" with `file://` so the test needs no network. Cover the fork-deleted fallback.
- **Accept:** for the local bare repo, the returned workspace has `headSha` checked out and `git merge-base base head` succeeds.

## E1.3 CLI + payload [ ] (pending live run)
**Files:** `bin/CodeSentinel.mjs`, `src/workflows/review.ts`, `src/review/config.ts`
- Parse `--pr <url>` and `--pr=<url>` in the bin, and put `prUrl` in the POST payload (around `bin/CodeSentinel.mjs:233`). Update `HELP`.
- In the workflow (or in the E4 `ingest` node, which supersedes this): if `cfg.prUrl` is set, run `materializePr` and override `cfg.workspace`, `cfg.baseSha` and `cfg.headSha`. When `GITHUB_TOKEN` is present, also set `cfg.github = {owner, repo, prNumber, token}`.
- Keep the existing behaviour unchanged when `prUrl` is absent.
- **Accept:** `node bin/CodeSentinel.mjs review --pr <public PR url>` with no token writes a local report about that PR's files. Verify manually on a small public PR and paste the output path.

## E1.4 Reporter targeting [x]
**Files:** `src/github/reporter.ts`, `src/review/config.ts`
- `createGithubReporter` already uses `cfg.github` plus `cfg.headSha` (`resolveCommitId`). Make sure E1.3 fills both.
- When the token can't write to the target repo (403 on the first post), stop throwing on every comment: switch once to the local reporter and log a single warning. A `fallbackOnForbidden` wrapper around the reporter is enough.
- **Tests:** a 403 on the first comment means every later comment lands in the local file.
- **Accept:** test passes.

## Pitfalls
- Shallow history makes `base...head` fail with "no merge base". Handle it with the deepen-and-retry in E1.2.
- Huge PRs: respect the existing `filterFiles` ignore globs. Also cap the review at 300 changed files, log a warning, and skip the rest.
- Temp dirs must be cleaned up on error as well, so wrap the whole graph invoke in try/finally.

## Done when
E1.1–E1.4 are ticked, and the manual run against a public PR is recorded in this file under `## Verification`.

## Verification

### Automated tests
- `tests/review/source.test.ts`: 10/10 tests pass covering `parsePrUrl` (URL formats, short forms, rejects invalid chars/hosts/numbers) and `materializePr` (mock Octokit, git clone/checkout against local bare repo, merge-base verification, cleanup).
- `tests/workflows/review.test.ts`: 9/9 tests pass covering PR materialization from `prUrl`, overriding workspace/shas/github target, worktree cleanup in `finally` on error or success, and capping at 300 files.
- `tests/github/reporter.test.ts`: 10/10 tests pass covering fallback on HTTP 403 Forbidden to local reporter, ensuring subsequent comments and summary land in the local report file without throwing or re-calling GitHub API.
- All 159 tests passing in vitest suite; `npm run check && npm run check:types && npm test && npm run build` pass with 0 errors.

### Manual CLI verification on public PR
- Command: `node bin/CodeSentinel.mjs review --pr https://github.com/noctalia-dev/noctalia/pull/4694`
- Tested against public repo `noctalia-dev/noctalia` PR `#4694` (+1 -22, `application_services.cpp`).
- Successfully parsed PR URL into `{ host: 'github.com', owner: 'noctalia-dev', repo: 'noctalia', number: 4694 }`, fetched PR metadata via Octokit, created isolated temp worktree, fetched refs (`refs/pull/4694/head`), checked out detached `head.sha`, parsed git diff, and handed off to workflow. Worktree directory cleaned up cleanly in `finally`. Full LLM completion proceeds as soon as an LLM provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) is supplied.
