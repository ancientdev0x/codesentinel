# E5: Human-in-the-loop workflows with unified diff patches

**Unlocks (C4a):** "human-in-the-loop workflows generating unified diff patches".
**Effort:** ~2 days. **Prereqs:** E4. **Needs CI-edit approval** for E5.5.

## Current state
- `suggest_change` puts free-text ```suggestion blocks into comments. A human applies them with GitHub's own button.
- No `.patch` files are produced.
- Nothing gates a change on human approval inside this code.

## Goal
1. Every confirmed finding that has a fix turns into a real, verified unified diff file.
2. A human approves, rejects, or edits each patch before anything is applied. There are two modes:
   - **interactive (local):** the LangGraph `interrupt()` pauses the graph, and the CLI asks the user. Resuming the same thread applies the approved patches.
   - **suggest (GitHub):** patches are posted as PR comments with ids. A trusted collaborator comments `/codesentinel apply <id>` (or `reject`), and the bot then commits the patch to the PR branch.

---

## E5.1 `buildPatch`
**File:** `src/review/patch.ts`
```ts
export interface Patch { id: string; findingId: string; file: string; diff: string; stats: { added: number; removed: number } }
export const buildPatch = async (workspace: string, f: Finding): Promise<Patch>
```
1. Read the file and replace lines `fix.startLine..fix.endLine` with `fix.replacement`. Keep the original line endings and the trailing newline.
2. Write the before and after copies to a tmp dir as `a/<path>` and `b/<path>`. Run `git diff --no-index --no-color -U3 a/<path> b/<path>` through execFile. Exit code 1 means there is a diff, so treat it as OK. Rewrite the headers to `--- a/<repoPath>` and `+++ b/<repoPath>`. This needs no new dependency.
3. Verify with `git -C <workspace> apply --check -` using the diff on stdin. If it fails, throw `PatchError('bad_patch')`. E4 validate turns that into a retry hint.
4. Reject any patch that touches lines outside the finding's range plus or minus 3 lines of context, or that changes more than 60 lines. Small patches are easier for humans to review.
5. `id` is the first 8 hex characters of the sha1 of the diff.

- **Tests:** a single-line fix and a multi-line fix both yield the exact expected diff text (snapshot). CRLF files are preserved. A stale fix (file changed) fails `--check`. Out-of-range edits are rejected.
- **Accept:** the tests pass, and the patch output applies with `git apply` in a temp repo.

## E5.2 `human_review` node
**File:** `src/graph/nodes/human-review.ts`
```ts
import { interrupt } from '@langchain/langgraph'
export const humanReview = (deps) => async (s) => {
  const patches = await buildPatches(s)            // confirmed findings with fix → Patch[]
  writePatchFiles(s.cfg.workspace, patches)        // .CodeSentinel/patches/<id>.patch (dir is git-ignored, like review/)
  if (s.cfg.hitlMode === 'interactive' && patches.length) {
    const decisions = interrupt({ type: 'patch_approval', patches: patches.map(toPreview) })
    // resume value: Record<patchId, 'approve' | 'reject' | { edit: string /* replacement diff */ }>
    const applied = await applyApproved(s.cfg.workspace, patches, decisions)   // git apply, then re-run --check per patch
    return { approvals: decisions, applied }
  }
  return { patches }   // 'suggest' → report node posts them; 'off' → report ignores them
}
```
- The interrupt payload must be JSON-serializable.
- The checkpointer and `thread_id` are already set up in E4.5.
- Read the current `interrupt` and `Command({resume})` docs before coding: Context7 `/websites/langchain_oss_javascript_langgraph`, "interrupts".
- Edited patches go through `git apply --check` again. If one fails, ask again (loop at most 2 times) instead of applying it.
- **Accept:** a unit test invokes the graph, receives `__interrupt__`, resumes with `Command({ resume: {<id>: 'approve'} })`, and checks that the file in the temp repo changed.

## E5.3 Local interactive CLI
**Files:** `bin/CodeSentinel.mjs`, `src/workflows/review.ts`
- The workflow returns `{ status: 'awaiting_approval', threadId, patches: [...] }` when the graph result contains `__interrupt__`.
- Add a second entry point that takes the input `{ resume: { threadId, decisions } }` and calls `graph.invoke(new Command({resume: decisions}), {configurable:{thread_id}})`.
- The CLI keeps the spawned server alive, because MemorySaver lives in that process. For each patch it prints the colored diff and prompts `[a]pply / [r]eject / [e]dit / [q]uit` using `node:readline/promises`. `e` opens `$EDITOR` on the patch file. The CLI then POSTs the resume.
- Add the flag `CodeSentinel review --interactive`, which sets `hitlMode:'interactive'`. Without a TTY, fall back to `suggest` with a warning.
- **Accept:** a manual run on the fixture repo approves one patch and rejects one. Check that `git diff` shows only the approved change, and paste the transcript into this file.

## E5.4 GitHub suggest mode + `/codesentinel apply`
**Files:** `src/github/reporter.ts`, `src/channels/github.ts` or `src/agents/mention.ts`, `src/review/patch-commands.ts`

Posting happens in the `report` node:
- Post an inline comment on the finding with a short explanation and a ```suggestion block, which keeps one-click apply.
- Under it, add `<details><summary>Patch <id> · +a −r</summary>` with a ```diff fence and a hidden marker `<!-- codesentinel:patch id=<id> sha=<headSha> -->`.
- Add a footer: "Reply `/codesentinel apply <id>` or `/codesentinel reject <id>`."

The command handler is `handlePatchCommand(event)`:
1. Parse the comment body with `/^\/codesentinel\s+(apply|reject)\s+([0-9a-f]{8})\b/im`.
2. Authorization: `author_association ∈ {OWNER, MEMBER, COLLABORATOR}`, enforced in code too, not only in the workflow `if`.
3. Find the patch comment by marker through the review comments API. Verify that the marker's `sha` equals the PR's current head SHA. If they differ, reply "patch is stale, re-run review".
4. `apply`:
   - Refuse fork PRs, because they can't be pushed with `GITHUB_TOKEN`. Say so in the reply.
   - Checkout the head ref, run `git apply --check`, then `git apply`, then commit `fix: apply CodeSentinel patch <id>` as the bot with a `Co-authored-by` trailer for the approver, then push.
   - Reply with the commit SHA and react 👍 to the command.
5. `reject`: react 👎, edit the patch comment to add "Rejected by @user", and record the decision. A later review run skips findings whose id was rejected, which acts as a lightweight feedback memory.
6. Log every decision to Langfuse (E6) as a score or event on the original trace if the trace id is in the marker. Add `trace=<id>` to the marker.

- **Tests:** mock Octokit and use a temp repo. Cover the parse regex, rejection of an unauthorized author, rejection of a stale SHA, refusal on a fork, the happy-path commit, and reject marking.
- **Verification:** Unit tests in `tests/review/patch-commands.test.ts` (9 tests) cover parse regex, author authorization, diff/metadata extraction, bot author verification, stale sha rejection, fork PR refusal, git apply & co-authored commit & push happy path, and reject comment update & memory recording. `tests/graph/nodes.test.ts` verifies report node skips previously rejected findings. All tests passing.

## E5.5 Workflow wiring (CI edit; ask first)
**File:** `.github/workflows/CodeSentinel-mention.yml`
- Add a job, or a branch in the existing job, for comments that match `/codesentinel (apply|reject)`, with the same author gate.
- It needs `permissions: contents: write, pull-requests: write`.
- Check out the **head ref**, not `refs/pull/N/head`, so it can push.
- Never run the PR's own code in this job. It applies a text patch only. No `npm install` of the PR's packages.
- **Verification:** `.github/workflows/CodeSentinel-mention.yml` updated with separate jobs for `/CodeSentinel` review runs vs `/codesentinel (apply|reject)` patch operations. The `patch` job has `contents: write, pull-requests: write`, checks out the head ref directly with `actions/checkout@v4`, runs isolated GitHub Script without PR code execution, verifies bot-authored comments and fresh SHA, applies via `git apply --check` and `git apply`, commits with approver co-author trailer, pushes to head ref, and records rejection in memory. Validated with `npm run check`.

## Security notes (do not simplify away)
- The patch comes from a comment the bot itself posted. Verify the comment author is the bot (`github-actions[bot]`), otherwise anyone could post a fake marker.
- Always use `git apply`, never `patch`, and always pass `--check` first. Reject paths with `..` or absolute paths.

## Done when
- E5.1–E5.5 are ticked.
- A test PR on a sandbox repo shows a patch comment, `/codesentinel apply <id>` produces the commit, and `reject` is honored on the next run.
- Screenshots are linked in `docs/EVAL.md`.
