# CodeSentinel Implementation Plan

This plan turns CodeSentinel into the system described in the resume entry below. It has nine epics, E0 to E8, and each has its own self-contained plan file. **Give a coding agent one epic per session**, in the order shown in the tree.

> **CodeSentinel: Autonomous DevSecOps Review Agent**
> - (C1) Built automated multi-stage review pipelines ingesting git diffs and PR URLs, extracting changed code fragments for strict AST-level checks.
> - (C2) Integrated sandboxed utilities using timeout isolation leveraging Bandit with Ruff, identifying security vulnerabilities and critical regressions.
> - (C3) Architected a LangGraph cyclic state engine orchestrating tool execution and failure analysis, running self-correcting recovery mechanisms.
> - (C4) Implemented human-in-the-loop workflows generating unified diff patches, tracking tool latency and tokens using strict Langfuse pipelines.

Current state and evidence: see `docs/RESUME_AUDIT.md`.

---

## Target architecture

```
                 ┌──────────── src/graph/review-graph.ts (LangGraph StateGraph) ────────────┐
 git diff ─┐     │                                                                           │
           ├─► ingest ─► extract_ast ─► static_analysis ─► llm_triage ─► validate ──┐       │
 PR URL ───┘     │            (E2)        (E3: bandit,ruff,   (flue agent,   (schema,  │       │
   (E1)          │                         ast-grep; docker    records        hunks,   │       │
                 │                         + timeout)          findings)      patches) │       │
                 │                              ▲                  ▲                    │       │
                 │                              │   retry w/ adj.  │  re-prompt w/      ▼       │
                 │                              └──────── failure_analysis ◄── errors && attempts<3
                 │                                                                    │ ok     │
                 │                                       human_review (interrupt) ◄───┘        │
                 │                                       (E5: patches, approve/reject)         │
                 │                                                  ▼                          │
                 │                                               report ─► GitHub / local file │
                 └──────────── every node + tool call traced to Langfuse (E6) ──────────────────┘
```

The stack stays TypeScript. `@flue/runtime` remains the inner LLM agent loop, and LangGraph becomes the outer orchestrator. Bandit and Ruff are Python CLIs run as sandboxed subprocesses, so they analyze Python code under review. ast-grep covers TS/JS and Python.

---

## Todo tree

Tick these off as you go. Each `E*` heading links to its plan, and every leaf is one commit-sized task.

- [ ] **E0 Foundation**: [`E0-foundation.md`](E0-foundation.md) *(prereq for all; ~0.5d)*
  - [x] E0.1 Restore `README.md` / `AGENTS.md` to the working tree (they are currently deleted, unstaged)
  - [x] E0.2 Add the shared `Finding` model in `src/review/findings.ts` (type, ids, dedupe, severity order)
  - [x] E0.3 Make the review workflow honor its payload (`input` schema + `resolveReviewConfig(input, env)`)
  - [x] E0.4 Add feature flags in config + `action.yml` inputs (`STATIC_ANALYSIS`, `SANDBOX`, `AST_CHECKS`, `HITL_MODE`, `LANGFUSE_*`)
  - [ ] E0.5 Add test fixtures: `tests/fixtures/vuln-repo/` (seeded Python + TS vulns, a git repo built at test time)
  - [ ] E0.6 Get approval for the dependency list below (AGENTS.md rule)
- [ ] **E1 PR URL ingestion** (C1): [`E1-pr-url-ingestion.md`](E1-pr-url-ingestion.md) *(~1d)*
  - [ ] E1.1 `parsePrUrl()` + tests
  - [ ] E1.2 `src/review/source.ts`: fetch PR meta, shallow-fetch head/base into a temp worktree
  - [ ] E1.3 CLI `CodeSentinel review --pr <url>` and payload `prUrl`
  - [ ] E1.4 Make the reporter target the URL's PR (post comments there when a token is available)
- [ ] **E2 AST fragment extraction + AST checks** (C1): [`E2-ast-extraction.md`](E2-ast-extraction.md) *(~1.5d)*
  - [ ] E2.1 `@ast-grep/napi` + Python language registration; `src/review/ast/parse.ts`
  - [ ] E2.2 `extractFragments()`: changed lines → enclosing function/class/method nodes
  - [ ] E2.3 Rule packs `src/review/ast/rules/{python,typescript}.yml` (sinks: eval/exec/shell/pickle/SQL concat/…)
  - [ ] E2.4 `runAstChecks()` → `Finding[]` restricted to changed lines
  - [ ] E2.5 Feed fragments (not raw `-U0` hunks) into the prompt
- [ ] **E3 Sandboxed static analysis: Bandit + Ruff** (C2): [`E3-static-analysis-sandbox.md`](E3-static-analysis-sandbox.md) *(~2d)*
  - [ ] E3.1 `src/sandbox/run.ts`: `runIsolated()` with execFile, timeout, SIGKILL, maxBuffer, typed result
  - [ ] E3.2 Docker backend (`--network none --read-only --cap-drop ALL …`) + `docker/analyzers.Dockerfile`
  - [ ] E3.3 Bandit adapter (JSON → `Finding`)
  - [ ] E3.4 Ruff adapter (`--select S,B,E9,F` JSON → `Finding`)
  - [ ] E3.5 Regression signals: Ruff F/E9 (undefined names, syntax errors) + `tsc --noEmit` / oxlint on TS changes
  - [ ] E3.6 `run_static_analysis` flue tool (agent can re-run on demand)
  - [ ] E3.7 Action wiring (install analyzers / build image) + summary section
- [ ] **E4 LangGraph cyclic state engine** (C3): [`E4-langgraph-engine.md`](E4-langgraph-engine.md) *(~2.5d, after E1–E3)*
  - [ ] E4.1 State schema (`src/graph/state.ts`)
  - [ ] E4.2 Nodes: ingest, extract_ast, static_analysis, llm_triage, validate, failure_analysis, report
  - [ ] E4.3 Replace direct posting: `record_finding` tool collects into state; posting moves to `report`
  - [ ] E4.4 Failure analysis + recovery routing (conditional edges, bounded retries, degrade paths)
  - [ ] E4.5 Checkpointer + thread ids; `review.ts` invokes the graph
  - [ ] E4.6 Graph tests with a fake LLM node (cycle taken, cycle bounded, degrade path)
- [ ] **E5 Human-in-the-loop + unified diff patches** (C4a): [`E5-hitl-patches.md`](E5-hitl-patches.md) *(~2d, after E4)*
  - [ ] E5.1 `buildPatch()`: finding fix → unified diff via `git diff --no-index`, verified with `git apply --check`
  - [ ] E5.2 `human_review` node using LangGraph `interrupt()`
  - [ ] E5.3 Local mode: CLI approve/reject/edit loop → `Command({ resume })` → `git apply`
  - [ ] E5.4 GitHub mode: patch comments with ids + `/codesentinel apply|reject <id>` handler
  - [ ] E5.5 Mention workflow update (needs CI-edit approval)
- [ ] **E6 Langfuse observability** (C4b): [`E6-langfuse-observability.md`](E6-langfuse-observability.md) *(~1d, can start after E0)*
  - [ ] E6.1 OTel + `LangfuseSpanProcessor` bootstrap, env-gated, flush on exit
  - [ ] E6.2 Trace per review; span per graph node
  - [ ] E6.3 `traced()` wrapper on every tool → per-tool latency + error level
  - [ ] E6.4 Generation observations with token `usageDetails` from flue
  - [ ] E6.5 Subprocess spans (bandit/ruff/docker) with duration, exit, timeout flag
  - [ ] E6.6 Strictness: schema-validated metadata, CI test that fails if a tool is unwrapped
- [ ] **E7 Evaluation + metrics** (makes "identifying vulnerabilities" provable): [`E7-eval-and-metrics.md`](E7-eval-and-metrics.md) *(~1d, last)*
  - [ ] E7.1 Ground-truth labels for the seeded fixtures
  - [ ] E7.2 `npm run eval`: deterministic stage recall/precision (no LLM, runs in CI)
  - [ ] E7.3 Full-pipeline eval (LLM, manual run) → `docs/EVAL.md` with numbers + Langfuse cost/latency
- [ ] **E8 Docs + resume sync**: [`E8-docs-and-resume.md`](E8-docs-and-resume.md) *(~0.5d)*
  - [ ] E8.1 README architecture + feature docs
  - [ ] E8.2 Final resume wording, with every phrase backed by a file and the eval numbers

### Dependency order

```
E0 ──► E1 ─┐
   ├─► E2 ─┼──► E4 ──► E5 ──► E7 ──► E8
   ├─► E3 ─┘           ▲
   └─► E6 ─────────────┘   (E6 can run in parallel; E4/E5 must call its helpers)
```

E1, E2, E3 and E6 are independent and can run as parallel agent sessions in separate git worktrees.

---

## Claim → epic coverage

| Resume phrase | Epic(s) | Proof artifact |
|---|---|---|
| multi-stage review pipelines | E4 | `src/graph/review-graph.ts` nodes |
| ingesting git diffs | (exists) + E0.3 | `src/review/diff.ts` |
| ingesting PR URLs | E1 | `CodeSentinel review --pr <url>` |
| extracting changed code fragments | E2.2 | `src/review/ast/fragments.ts` |
| strict AST-level checks | E2.3–E2.4 | `src/review/ast/rules/*.yml` |
| sandboxed utilities, timeout isolation | E3.1–E3.2 | `src/sandbox/run.ts`, `docker/analyzers.Dockerfile` |
| Bandit with Ruff | E3.3–E3.4 | `src/review/analyzers/{bandit,ruff}.ts` |
| security vulnerabilities and critical regressions | E3.5 + E7 | `docs/EVAL.md` recall table |
| LangGraph cyclic state engine | E4 | conditional edge back to `llm_triage` / `static_analysis` |
| tool execution and failure analysis | E4.4 | `failure_analysis` node |
| self-correcting recovery | E4.4 | retry/degrade routes + tests |
| human-in-the-loop workflows | E5.2–E5.4 | `interrupt()` + `/codesentinel apply` |
| unified diff patches | E5.1 | `.CodeSentinel/patches/*.patch` |
| tool latency and tokens, Langfuse | E6 | Langfuse trace screenshot in README |
| strict pipelines | E6.6 | test enforcing every tool is traced |

---

## Dependencies to approve (E0.6)

AGENTS.md says to ask before adding dependencies or editing CI. Approve these up front:

| Package | Why | Epic |
|---|---|---|
| `@langchain/langgraph` (+ peer `@langchain/core`, `zod`) | state graph, checkpointer, interrupt | E4, E5 |
| `@ast-grep/napi`, `@ast-grep/lang-python` | AST parsing + rule engine (TS/JS built in, Python via dynamic lang) | E2 |
| `@langfuse/tracing`, `@langfuse/otel`, `@opentelemetry/sdk-node` | tracing | E6 |
| Python `bandit`, `ruff` (pinned, **not** npm deps) | analyzers, installed in the Docker image / Action step | E3 |

CI edits needed: `action.yml` (E0.4, E3.7, E6), `.github/workflows/CodeSentinel-mention.yml` (E5.5), `.github/workflows/pr.yml` (E7.2 eval job).

No other new deps. Unified diffs come from `git diff --no-index`, and hashing uses `node:crypto`.

---

## Rules for the coding agent (paste into every session)

```
You are implementing epic <EX> of docs/plan/<file>.md in the CodeSentinel repo.
Read docs/plan/00-INDEX.md and docs/plan/<file>.md fully first, then AGENTS.md.
- Do only the tasks in this epic. Do not refactor unrelated code.
- Before using any library API (LangGraph, Langfuse, ast-grep, Octokit, flue), fetch
  current docs (Context7) or read node_modules/<pkg> types. Plan snippets are sketches,
  not verified signatures.
- For flue (@flue/runtime) behaviour, read node_modules/@flue/runtime/dist/*.d.ts.
  Do not guess.
- One commit per leaf task, Conventional Commits (feat:, fix:, test:, chore:).
- After each task run: npm run check && npm run check:types && npm test.
  Run npm run build at the end of the epic.
- Every task lists Acceptance criteria. Do not tick a task until they pass. Paste the
  command output in your final report.
- Ask before adding deps not listed in 00-INDEX.md, and before editing CI workflows
  not listed there.
- If a plan assumption is wrong (e.g. an API differs), stop, write the discrepancy into
  the epic file under "## Deviations", choose the minimal fix, and continue.
```

## Global definition of done

1. `npm run check && npm run check:types && npm run build && npm test` is green.
2. `npm run eval` is green, and its numbers are recorded in `docs/EVAL.md`.
3. A real PR review run shows: AST fragments in the prompt, Bandit/Ruff findings triaged, at least one graph retry visible in Langfuse, and patch comments with a working `/codesentinel apply`.
4. Every resume phrase in the coverage table points to a file that exists on `main`.
