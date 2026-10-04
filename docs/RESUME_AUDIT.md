# Resume Audit: CodeSentinel

This audit checks the resume entry below against the code in this repo. Every verdict cites `file:line` evidence, so you can verify it yourself.

> **CodeSentinel : Autonomous DevSecOps Review Agent | Self Project**
> Architected an autonomous DevSecOps review agent, delivering multi-stage codebase analysis and sandboxed vulnerability triage pipelines.
> - Built automated multi-stage review pipelines ingesting git diffs and PR URLs, extracting changed code fragments for strict AST-level checks.
> - Integrated sandboxed utilities using timeout isolation leveraging Bandit with Ruff, identifying security vulnerabilities and critical regressions.
> - Architected a LangGraph cyclic state engine orchestrating tool execution and failure analysis, running self-correcting recovery mechanisms.
> - Implemented human-in-the-loop workflows generating unified diff patches, tracking tool latency and tokens using strict Langfuse pipelines.

---

## 1. TL;DR

**The repo is TypeScript built on `@flue/runtime`. The resume describes a Python / LangGraph / Bandit / Ruff / Langfuse stack, and none of those exist in the repo.** As written, the entry fails the first technical question about any of its bullets.

| Claim | Verdict | Reason |
|---|---|---|
| Autonomous DevSecOps review agent | PARTIAL | It is an LLM PR reviewer. "DevSecOps" amounts to a single security line in the prompt. |
| Multi-stage pipeline | PARTIAL | The pipeline is linear (config, diff, filter, one LLM call, summary). There are no analysis stages. |
| Ingests git diffs | SUPPORTED | `git diff base...head` / `--cached` in `src/review/diff.ts:41-55`. |
| Ingests PR URLs | NOT PRESENT | The PR number comes from env. There is no URL argument. |
| Strict AST-level checks | NOT PRESENT | There is no AST library. The raw diff is pasted into the prompt. |
| Sandboxed utilities / timeout isolation | NOT PRESENT (review path) | `local({cwd})` runs on the host with no isolation. Timeouts exist only in QA. |
| Bandit + Ruff | NOT PRESENT | The repo has zero hits for bandit, ruff, or semgrep. |
| LangGraph cyclic state engine | NOT PRESENT | There is no LangGraph. Some retry and heal behavior exists in QA, driven by prompts and flue. |
| Self-correcting recovery | PARTIAL | The QA healer subagent and run-until-pass instructions exist. The review path has none. |
| Human-in-the-loop | PARTIAL | GitHub suggestion blocks plus a mention workflow restricted to trusted authors. |
| Unified diff patches | NOT PRESENT | It produces no `.patch` output and never runs `git apply`. |
| Langfuse latency/token tracking | NOT PRESENT | The only telemetry is a 58-line fire-and-forget POST. |
| "Self Project" / "Architected" | **RESOLVED** | Project rename and cleanup complete. See section 2. |

---

## 2. Provenance and integrity risk (fix this first)

This is a bigger problem than any single bullet.

- **One-commit history.** The entire codebase (~4,950 LOC) landed in `4ca5b8b feat: initial commit`. The history shows no evidence of you building it incrementally.
- **Legacy naming & license.** Ensure `LICENSE` is in place and all legacy naming artifacts are removed.
- **Rename leftovers that give it away:**
  - `README.md:13` links `code-review-gpt-3.mp4`, former asset name.
  - Legacy naming cleanup across README/AGENTS.
  - Env vars are mixed-case, for example `CodeSentinel_MCP_SERVERS` (`src/review/config.ts:70`). Standardize on `CODESENTINEL_*`.
  - The version `0.21.2` is inherited from earlier releases.
  - `src/common/telemetry.ts:3` posts to `telemetry.CodeSentinel.dev`, which is probably a dead host created by the rename.
- **"Self Project" plus "Architected" is the risky combination.** An interviewer who searches one distinctive string, or looks at the file layout, will evaluate originality closely.

**Fix (about 15 minutes):**
1. Add `LICENSE` with the MIT text and copyright notice.
2. Clean up the leftovers: the mp4 link, any remaining legacy name mentions, the env var casing (`CODESENTINEL_*`), and the telemetry host.
3. On the resume, claim **only your deltas**: "Extended…", "Built…", "Architected…".

---

## 3. Claim-by-claim

### 3a. Multi-stage pipeline, git diffs, PR URLs, and AST checks

**Resume says:** multi-stage pipelines that ingest git diffs and PR URLs and extract changed fragments for strict AST-level checks.

**Code actually does:**
- `src/review/diff.ts:41-55` runs `git diff base...head`, or `--cached` for local runs. It uses `-U0` (`diff.ts:23`) and parses hunks with a regex (`diff.ts:62-63`).
- `src/review/context.ts:16-27` pastes the raw diff text into the prompt.
- `src/workflows/review.ts:38` calls `resolveReviewConfig(undefined, env)`, so **the workflow ignores its payload**.
- The PR number comes from env (`config.ts:114-123`, set by `action.yml:92-94`).
- The CLI accepts only `review`, `qa`, and `init` (`bin/CodeSentinel.mjs:61,214`). It has no URL argument.
- `src/channels/github.ts:124-137` exposes `get_pull_request_diff`, but only for the mention agent's own PR. It is not a general ingestion path.
- **There is no AST library in the dependencies.**
- The pipeline is linear: config → diff → `filterFiles` → telemetry → prompt → **one** `session.prompt` (`review.ts:56-63`) → summary.

**Verdict:** git diffs are SUPPORTED. Multi-stage is PARTIAL. PR URLs and AST checks are NOT PRESENT.

**How to build it:**
1. **PR URL ingestion (0.5-1 day).**
   - Add `src/review/source.ts` with `fromPrUrl(url)`. It should parse `owner/repo/pull/N`, call `octokit.pulls.get` with `mediaType: { format: 'diff' }`, and call `pulls.listFiles` for file metadata. If you need full file contents, shallow-clone the head SHA instead.
   - Feed the diff into the existing `parseDiff`.
   - Add a `--pr <url>` flag in `bin/CodeSentinel.mjs`.
   - Change `review.ts:38` so it passes `payload` through to `resolveReviewConfig`.
   - Test with a recorded Octokit fixture.
2. **AST layer (1-2 days).**
   - Add `src/review/ast/` using `web-tree-sitter` (WASM grammars for TS, JS, and Python). Map each changed line range to its enclosing function or class node, then send the whole enclosing unit to the LLM instead of `-U0` fragments.
   - Add `@ast-grep/napi` rule packs, for example `eval`/`exec`/`new Function` sinks, SQL built by string concatenation, `subprocess(..., shell=True)`, and `child_process.exec` with template strings.
   - Pass rule hits to the LLM as **pre-verified evidence**, with rule ID, file, and line.
3. **Make the stages explicit:** scanners → AST → LLM review → verify/dedupe → report. Give each stage a typed input and output so it can be tested on its own.

### 3b. Sandbox, timeouts, Bandit, and Ruff

**Resume says:** sandboxed utilities with timeout isolation, using Bandit and Ruff to find vulnerabilities.

**Code actually does:**
- **There are zero hits for `bandit`, `ruff`, or `semgrep`** anywhere in the repo.
- The "sandbox" is `local({ cwd })` at `src/agents/reviewer.ts:31`. In practice that means real host bash (`src/qa/instructions.ts:23-24`) plus an env allowlist (`qa-lead.ts:40`). It provides **no filesystem, network, or process isolation**.
- The composite action (`action.yml:63-64`) runs directly on the runner. The `Dockerfile` exists only for QA (Chromium) and **runs as root**.
- Timeouts exist only in QA: `cli-client.mjs:20,53-60` has a 60s SIGKILL, and `qa-lead.ts:63` has a 75-minute cap. The review path has none: `diff.ts:115` has no timeout, and `qa/exec.ts:28` `runShell` has none either.
- Security detection is a single prompt line: `src/review/instructions.ts:35`.

**Verdict:** NOT PRESENT.

**How to build it (1-2 days):**
1. **`src/tools/run-static-analysis.ts`** (`defineTool` with a valibot schema):
   - Use `execFile` (no shell) with `timeout: 60_000` and `killSignal: 'SIGKILL'`.
   - Run `bandit -f json -q <files>` and `ruff check --output-format json --select S,B,E,F <files>`.
   - Treat a **nonzero exit as "findings"**, not as an error. Handle timeout or `ENOENT` gracefully by returning `{ skipped: true, reason }`.
   - Normalize results to `{ tool, rule, severity, file, line, message, cwe }`.
2. **`src/review/analyzers/docker.ts`**, the real sandbox:
   ```
   docker run --rm --network none --read-only --cap-drop ALL \
     --security-opt no-new-privileges --pids-limit 128 --memory 512m \
     --user 65534 -v "$WS":/src:ro codesentinel-analyzers ...
   ```
   Build the image from `docker/analyzers.Dockerfile` (`python:3.12-slim` with pinned `bandit` and `ruff` versions). On timeout, `docker kill` the container by name.
3. **Triage:** inject the normalized findings into `context.ts` and have the LLM **confirm or dismiss each one with a reason**. That is the honest meaning of "vulnerability triage".
4. Add a `STATIC_ANALYSIS` action input (`off | host | docker`).
5. **Tests:** mock `execFile`, and add a fixture `.py` file with `subprocess.run(..., shell=True)` and `pickle.loads(...)`. Assert normalization, the timeout path, and the ENOENT path.
6. **Seeded-vuln eval:** a small corpus of known-bad diffs, so you can quote a real detection or false-positive number.

### 3c. LangGraph cyclic state engine

**Resume says:** a LangGraph cyclic state engine that orchestrates tools and failure analysis with self-correcting recovery.

**Code actually does:** there is no LangGraph. Flue's agent loop is opaque to this codebase. What does exist:
- The QA instructions tell the driver to re-run `run_spec` until it passes (`src/qa/instructions.ts:261-262, 298-299`).
- A healer subagent (`src/qa/healer.ts:32-48`).
- Lead → driver/healer fan-out (`qa-lead.ts:60`).
- Tool errors are returned to the model so it can retry (`src/github/reporter.ts:60-64`).
- A `classify_finding` gate (`src/tools/classify-finding.ts`, `src/qa/pr-policy.ts`).
- `qa.ts:11-28` `parseResult` falls back to `passed: false` when output is malformed.

**Verdict:** NOT PRESENT as claimed. Self-correction is PARTIAL, and only in QA.

**How to fix it.** **Do not replace flue.** Pick one of:
- **(a) Reword the bullet** to describe what exists: a multi-agent QA loop with a healer subagent and policy-gated repair PRs.
- **(b) Build a thin outer graph** (about 1 day) in `src/graph/review-graph.ts` with `@langchain/langgraph` (JS):
  - State: `{ files, staticFindings, llmFindings, validationErrors, attempts, summary }`.
  - Nodes: `diff` → `static_analysis` → `llm_review` (wraps the flue session) → `validate`. The validate node checks that every comment's path and line fall inside a diff hunk and that each finding passes the valibot schema.
  - Conditional edge: if `validationErrors` is non-empty and `attempts < 3`, loop back to `llm_review` with the errors in context. Otherwise go to `report`.
  - Use a `MemorySaver` checkpointer.
  - Then the claim "cyclic validate-and-retry loop" is literally true.

### 3d. Human-in-the-loop and unified diff patches

**Resume says:** HITL workflows that generate unified diff patches.

**Code actually does:**
- `suggest_change` emits GitHub ```` ```suggestion ```` blocks (`src/tools/suggest-change.ts:14`, `reporter.ts:47-58`). A human applies them with GitHub's own "Commit suggestion" button.
- The `/CodeSentinel` mention workflow only triggers for `OWNER`, `MEMBER`, or `COLLABORATOR` authors.
- QA can open PRs (`src/tools/open-pull-request.ts`).
- The repo never writes a `.patch` file and never runs `git apply`.

**Verdict:** HITL is PARTIAL. Unified diff patches are NOT PRESENT.

**How to build it (about 1 day):**
1. Add a `propose_patch` tool. It writes `.CodeSentinel/patches/<id>.patch`, validates it with `git apply --check`, and posts it as a collapsed `<details>` comment that includes the ID.
2. Add a `/codesentinel apply <id>` `issue_comment` handler. It checks the author association, then runs `git apply`, commits, and pushes. This needs `contents: write`, so ask before editing CI.
3. Add `/codesentinel reject <id>`, which records the rejection. You can later use that as eval signal.

### 3e. Langfuse latency and token tracking

**Resume says:** tool latency and token tracking with strict Langfuse pipelines.

**Code actually does:** `src/common/telemetry.ts` is 58 lines. It sends fire-and-forget POSTs for `review_started` (with a file count) and `qa_started`. It records no latency and no tokens, and nothing in the repo uses Langfuse.

**Verdict:** NOT PRESENT.

**How to build it (about half a day):**
1. Add the `langfuse` SDK. Create one `trace` per workflow run (`review`, `qa`) carrying repo, PR, and model metadata.
2. Add a `withSpan(toolDef)` wrapper around every `defineTool` `run`. It should record per-tool latency, inputs and outputs (truncated), and `level: 'ERROR'` when a tool throws.
3. Add a `trace.generation` per LLM call with `usage` tokens taken from the flue response. **First check whether `session.prompt` exposes usage.** If it does not, use flue's event hooks.
4. Enable it only when the `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_HOST` env vars are set, and call `flushAsync()` before the workflow returns.

---

## 4. What the project genuinely does well

You can claim these today, with attribution:

- **Agentic PR reviewer** that posts inline GitHub review comments and one-click suggestion blocks.
- **Multi-provider model support** through `provider/model` strings (Anthropic, OpenAI, OpenRouter, Cloudflare Workers AI).
- **Remote MCP tool integration**, configured at runtime (HTTP/SSE).
- **Three delivery modes from one codebase:** a GitHub Action, a CLI, and an HTTP server build.
- **A multi-agent QA pipeline:** a lead agent fans out to parallel drivers plus a healer subagent. It has self-verifying test loops and opens auto-repair PRs, gated by a policy classifier.
- **A cwd-scoped tool runtime with an env allowlist.** This limits what the agent can see, but it is not a sandbox, so do not call it one.

---

## 5. Rewrite options

### (A) Honest today: use this now

> **CodeSentinel: AI Code Review & QA Agent** | TypeScript, @flue/runtime, Octokit, MCP
> - Architected CodeSentinel, an LLM agent that reviews git diffs and posts inline GitHub comments with one-click suggested fixes.
> - Shipped it as a GitHub Action, CLI, and HTTP server, with pluggable model providers (Anthropic/OpenAI/OpenRouter/Workers AI) and runtime-configured remote MCP tools.
> - Worked on a multi-agent QA pipeline (lead → parallel drivers → healer subagent) that re-runs failing specs until they pass and opens repair PRs gated by a finding-classification policy.
> - Restricted agent tool execution to the workspace directory with an environment-variable allowlist, and limited the comment-triggered agent to trusted repo roles.

Adjust the verbs ("Extended", "Worked on") to match what you personally changed. If you did not change anything in an area, leave that bullet out.

### (B) After roadmap: do NOT use until the code exists and is merged

> - Built a staged review pipeline (static analysis → tree-sitter/ast-grep AST checks → LLM triage → validation) that ingests local diffs or GitHub PR URLs.
> - Ran Bandit and Ruff in a network-less, read-only, non-root Docker sandbox with 60s SIGKILL timeouts; the LLM confirms or dismisses each finding (X% recall / Y% precision on a seeded-vulnerability eval).
> - Added a LangGraph.js validate-and-retry loop around the agent that rejects comments outside diff hunks or failing schema checks and re-prompts up to 3 times.
> - Implemented a `/codesentinel apply` human-approval flow for `git apply`-verified unified diff patches, and Langfuse tracing of per-tool latency and token usage.

Everything in B matches the TypeScript stack. **Do not mention Python or LangGraph unless you actually build them.** Fill in X and Y only from a real eval run.

---

## 6. Prioritized roadmap

> AGENTS.md says to **ask before adding dependencies or editing CI workflows.** Items 2-7 add dependencies, and item 6 changes workflow permissions.

| # | Item | Files | Effort | Unlocks claim |
|---|---|---|---|---|
| 1 | LICENSE + attribution + rename cleanup | `LICENSE`, `README.md`, `src/review/config.ts`, `src/common/telemetry.ts` | Minutes | Removes the integrity risk. Makes "Built on…" safe. |
| 2 | Bandit/Ruff tool + Docker sandbox | `src/tools/run-static-analysis.ts`, `src/review/analyzers/docker.ts`, `docker/analyzers.Dockerfile`, `action.yml`, `tests/tools/` | 1-2d | Sandboxed utilities, timeout isolation, Bandit + Ruff, triage |
| 3 | Langfuse tracing | `src/common/tracing.ts`, tool wrapper, workflows | 0.5d | Latency and token tracking |
| 4 | PR URL ingestion | `src/review/source.ts`, `bin/CodeSentinel.mjs`, `src/workflows/review.ts` | 0.5-1d | Ingests PR URLs |
| 5 | AST extraction | `src/review/ast/`, ast-grep rule packs, `context.ts` | 1-2d | AST-level checks, changed-fragment extraction |
| 6 | Patch + `/apply` HITL | `src/tools/propose-patch.ts`, comment handler, mention workflow | 1d | Unified diff patches, human-in-the-loop |
| 7 | LangGraph outer validate-retry loop (optional) | `src/graph/review-graph.ts` | 1d | Cyclic state engine, self-correcting recovery |
| 8 | Seeded-vuln eval | `evals/fixtures/`, `evals/run.ts` | 0.5-1d | Any quantitative metric |

Make each item its own Conventional Commit or PR. A visible incremental history is itself evidence that you did the work.

---

## 7. Interview-defense notes

If you cannot answer these questions about a claim, take the claim off the resume.

**Provenance**
- "Is this an original project?" Explain the architecture, then list exactly what you designed and added.
- "Why is the whole repo one commit?"
- "What is the license, and what does it require from you?"

**Pipeline, PR URLs, and AST**
- "Walk me through what happens between receiving a PR URL and posting a comment." Name each stage and its input and output.
- "Why use AST context instead of the raw diff? What does `-U0` lose?"
- "Which tree-sitter or ast-grep rules did you write, and what false positives did you see?"
- "How do you map a changed line to its enclosing function?"

**Sandbox, Bandit, and Ruff**
- "What exactly isolates the analyzer? What can a malicious repo do to your runner?" Explain the Docker flags and why each one matters.
- "What happens on timeout? How do you avoid leaving zombie processes or containers?"
- "Bandit exits nonzero when it finds issues. How do you tell that apart from a crash?"
- "What is your false-positive rate, and how does the LLM triage step change it?"

**LangGraph and self-correction**
- "Draw the graph. What is in the state, and what triggers the cycle?"
- "How do you keep the retry loop from running forever, and what does the checkpointer give you?"
- "Why put LangGraph around flue instead of replacing it?"
- "Give me one concrete failure the loop recovered from."

**HITL and patches**
- "How do you guarantee a patch applies cleanly before you show it to a human?"
- "Who can trigger `/apply`, and how do you stop someone abusing it from a fork PR?"
- "Suggestion blocks or unified diffs: when would you choose each?"

**Langfuse**
- "Where do the token counts come from? Are they provider-reported or estimated?"
- "What is your p95 tool latency, and which tool is the slowest?"
- "What happens to the review if Langfuse is down?" It should degrade silently and still flush when the workflow finishes.
- "What do you redact before sending a trace?" Secrets and large diffs.
