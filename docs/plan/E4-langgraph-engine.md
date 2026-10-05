# E4 — LangGraph cyclic state engine with failure analysis and self-correction

**Unlocks (C3):** "LangGraph cyclic state engine orchestrating tool execution and failure analysis, running self-correcting recovery mechanisms". It also delivers "multi-stage review pipelines" (C1).
**Effort:** ~2.5 days. **Prereqs:** E1, E2, E3 (E6 recommended).

## Current state
`src/workflows/review.ts:38-77` is a linear script with a single `session.prompt()` call. The agent posts comments directly through `suggest_change`, so its output is never validated and nothing gets retried.

## Design decision
- **Keep flue as the inner agent loop**, because it handles the sandbox, subagents, MCP and providers.
- **Add LangGraph as the outer orchestrator.** The graph owns stage ordering, tool execution, validation, failure classification and recovery cycles.
- This is the minimum needed to make the claim honest without rewriting the agent.

**Verify the API first.** The current LangGraph JS uses `StateSchema` / `ReducedValue` with zod (`import { StateGraph, StateSchema, ReducedValue, START, END, MemorySaver } from '@langchain/langgraph'`). Older docs use `Annotation.Root`. Use whichever the installed version documents (Context7 `/websites/langchain_oss_javascript_langgraph`).

---

## E4.1 State
**File:** `src/graph/state.ts`
```ts
const ReviewState = new StateSchema({
  cfg: z.custom<ReviewConfig>(),
  files: z.array(z.custom<ReviewFileWithDiff>()).default([]),
  fragments: z.array(z.custom<CodeFragment>()).default([]),
  staticFindings: z.array(z.custom<Finding>()).default([]),
  llmFindings: z.array(z.custom<Finding>()).default([]),
  summary: z.string().default(''),
  attempts: z.record(z.string(), z.number()).default({}),   // per node: { llm_triage: 1, static_analysis: 0 }
  errors: new ReducedValue(z.array(z.custom<StageError>()).default(() => []),
                           { inputSchema: z.array(z.custom<StageError>()), reducer: (a, b) => a.concat(b) }),
  degraded: z.array(z.string()).default([]),                // tools/stages skipped after unrecoverable failure
  recovery: z.custom<RecoveryPlan | null>().default(null),
  approvals: z.record(z.string(), z.enum(['approve','reject'])).default({}), // E5
})
export interface StageError {
  stage: 'ingest'|'extract_ast'|'static_analysis'|'llm_triage'|'validate'
  kind: 'timeout'|'unavailable'|'crash'|'invalid_output'|'out_of_diff'|'bad_patch'|'empty_review'|'provider_error'
  detail: string; findingId?: string; tool?: string
}
export interface RecoveryPlan { retry: 'static_analysis'|'llm_triage'|null; hints: string[]; adjust?: { timeoutMs?: number; backend?: 'host'; skipTools?: string[] } }
```
- **Accept:** types compile. Add a unit test that the `errors` reducer concatenates.

## E4.2 Nodes
**Dir:** `src/graph/nodes/`. There is one file per node. Each is a pure function of `(state, deps)` that returns a partial state, and `deps` is injected for testability.

| Node | Does | Reuses |
|---|---|---|
| `ingest` | `materializePr` if `prUrl`, else `getChangedFiles`. Then `filterFiles` and the 300-file cap | E1, `diff.ts`, `filterFiles` |
| `extract_ast` | `extractFragments` per file, plus `runAstChecks` into `staticFindings` | E2 |
| `static_analysis` | `runStaticAnalysis(cfg + recovery.adjust)`. Converts each non-ok `RunResult` into a `StageError` | E3 |
| `llm_triage` | Opens a flue session and prompts with fragments, pre-detected findings and (on retry) `recovery.hints`. The agent records results via `record_finding` / `triage_finding` tools (E4.3) | flue `harness.session()` |
| `validate` | Strict checks on every LLM finding (below). Pushes a `StageError` per violation | `FindingSchema`, `onlyChanged` |
| `failure_analysis` | Classifies `errors` and builds a `RecoveryPlan` (E4.4) | — |
| `human_review` | E5 (pass-through until then) | — |
| `report` | Dedupes, posts inline comments, posts the summary, writes the analyzer table | `reporter.ts`, `summary.ts` |

`validate` checks:
1. Each finding passes `FindingSchema` (valibot).
2. `file` exists in `state.files`.
3. The `startLine..endLine` range intersects a changed range (`onlyChanged`). This used to surface as a GitHub 422 at post time.
4. Every pre-detected finding with severity ≥ medium has a triage decision (confirmed or dismissed with a rationale).
5. `fix` (if any) is checked with E5.1 `buildPatch` + `git apply --check`. Failures are `bad_patch`.
6. If `summary` is empty, record `empty_review`.

## E4.3 Collect instead of post
**Files:** `src/tools/record-finding.ts`, `src/tools/triage-finding.ts`, `src/agents/reviewer.ts`, `src/review/instructions.ts`
- `record_finding({file, startLine, endLine, severity, message, cwe?, fix?})` pushes into a per-run collector and returns `"recorded <id>"`.
- `triage_finding({id, decision:'confirm'|'dismiss', rationale})` updates a pre-detected finding.
- Collector plumbing: the agent initializer only gets `env`, so use a module-level `Map<runId, Collector>` keyed by `CodeSentinel_RUN_ID`, which the workflow sets before `harness.session()`. Delete the entry when the run finishes. Document this hack with a comment explaining why it is needed.
- Keep `suggest_change` behind `hitlMode==='off' && legacy` for backward compatibility, or delete it if no tests or docs depend on it. Prefer deleting it.
- Update the instructions to say: "Do not post. Record findings with `record_finding`. Triage every pre-detected finding with `triage_finding`."
- **Accept:** a unit test confirms the tools mutate the collector and that invalid input throws, so the model sees the error and corrects itself.

## E4.4 Failure analysis and recovery (the "cyclic, self-correcting" part)
**File:** `src/graph/nodes/failure-analysis.ts`. This is a **deterministic** classifier, so it is testable and needs no extra LLM call.

| Error kind (stage) | Recovery | Bound |
|---|---|---|
| `timeout` (static_analysis) | retry `static_analysis` with `timeoutMs*2` for that tool only | 1 retry, then add the tool to `degraded` |
| `unavailable` docker (static_analysis) | retry with `backend:'host'` | 1, then degrade |
| `unavailable` host / `crash` | degrade that tool and note it in the summary | 0 |
| `invalid_output` / `out_of_diff` / `bad_patch` / missing triage (validate) | retry `llm_triage` with hints listing the exact violations, e.g. "finding a1b2 targets L90 but changed lines are 12–30; move it or drop it" | `cfg.maxAttempts` (3) |
| `provider_error` (llm_triage) | retry `llm_triage` after `2^n` s backoff | 2 |
| `empty_review` | retry `llm_triage` once with "you must end with a summary" | 1 |
| anything left after the bounds | drop the offending findings, set `degraded`, continue to `report` | — |

Rules:
- On retry, `llm_triage` **reuses the same flue session** (`session.prompt(hints)`) so the model keeps its context and fixes only what failed. Before acting, check that flue sessions support follow-up prompts.
- If you open a new session, re-send the full context.

## E4.5 Wiring
**Files:** `src/graph/review-graph.ts`, `src/workflows/review.ts`

```ts
export const buildReviewGraph = (deps: Deps) => new StateGraph(ReviewState)
  .addNode('ingest', ingest(deps)).addNode('extract_ast', extractAst(deps))
  .addNode('static_analysis', staticAnalysis(deps)).addNode('llm_triage', llmTriage(deps))
  .addNode('validate', validate(deps)).addNode('failure_analysis', failureAnalysis)
  .addNode('human_review', humanReview(deps)).addNode('report', report(deps))
  .addEdge(START, 'ingest')
  .addConditionalEdges('ingest', s => s.files.length ? 'extract_ast' : END)
  .addEdge('extract_ast', 'static_analysis')
  .addConditionalEdges('static_analysis', s => hasNew(s.errors, 'static_analysis') ? 'failure_analysis' : 'llm_triage')
  .addEdge('llm_triage', 'validate')
  .addConditionalEdges('validate', s => hasNew(s.errors, 'validate','llm_triage') ? 'failure_analysis' : 'human_review')
  .addConditionalEdges('failure_analysis', s => s.recovery?.retry ?? 'llm_triage_or_report')  // → static_analysis | llm_triage | human_review
  .addEdge('human_review', 'report').addEdge('report', END)
```
- Track "new" errors with a cursor, or clear the handled errors in `failure_analysis` (simpler: store `handledErrorCount` in state).
- Compile with the `MemorySaver` checkpointer. `thread_id` is `CodeSentinel_RUN_ID` (a UUID per run). E5 needs this for `interrupt`.
- Add a `recursionLimit` (around 25) as a final guard against infinite cycles.
- `review.ts` `run()` becomes: build deps, `graph.invoke({cfg}, {configurable:{thread_id}})`, return `{reviewed, findings, degraded, attempts, summaryUrl}`.
- Export `drawMermaid` output to `docs/ARCHITECTURE.md` with `graph.getGraph().drawMermaidPng`/`drawMermaid` if available, so the README can show the real graph.

## E4.6 Tests
**File:** `tests/graph/review-graph.test.ts`. Inject fake deps with no LLM or network.
1. **Happy path:** each node is visited once, and `report` gets the confirmed findings.
2. **Self-correction:**
   - The fake `llm_triage` returns an out-of-diff finding on attempt 1 and a fixed one on attempt 2.
   - Assert that `validate` ran twice, the hint text contains the violation, and the final findings are valid.
3. **Bounded:** the fake always returns invalid output. Assert it stops at `maxAttempts`, drops the bad findings, puts `llm_triage` in `degraded`, and still reports.
4. **Tool recovery:** fake Bandit times out, the retry has a doubled timeout, and it succeeds.
5. **Docker fallback:** `unavailable` (docker) leads to a retry on the host backend.
6. **Never-throws:** every node's dependency throws, and the graph still reaches `report` with a summary listing what degraded.

## Done when
- [x] E4.1–E4.6 are ticked.
- [ ] A real `flue run review` on the fixture repo shows the node sequence in logs, and the sequence includes at least one cycle. Force one by setting `CodeSentinel_ANALYZER_TIMEOUT_MS=1`. (pending live run)
- [x] `docs/ARCHITECTURE.md` contains the generated graph diagram.

## Deviations
- **Legacy Return Type Compatibility:** To maintain full backward compatibility with existing tests that assert exact object shapes on `review.ts` (`{ reviewed, summaryPosted, summaryUrl, summary }`), the additional state properties `{ findings, degraded, attempts }` are attached as non-enumerable properties using `Object.defineProperties()`. This satisfies both graph callers inspecting findings/degraded/attempts and legacy callers expecting the original four enumerable keys.
- **Flue CLI Flag:** Flue CLI beta.9 uses `--input '<json>'` rather than `--payload '<json>'`. Local test invocations use `--input`.
- **Session Continuity in LLM Triage:** Flue sessions support follow-up prompts (`session.prompt(hints)`). We cache active sessions per run so that self-correction cycles retain full agent conversational memory and context without needing to resend the initial instructions from scratch.

## Verification
- **Unit and Graph Tests:**
  `npm test tests/graph tests/tools/record-triage-findings.test.ts`
  ```
   ✓ tests/graph/state.test.ts (2 tests)
   ✓ tests/graph/nodes.test.ts (8 tests)
   ✓ tests/tools/record-triage-findings.test.ts (3 tests)
   ✓ tests/graph/failure-analysis.test.ts (8 tests)
   ✓ tests/graph/review-graph.test.ts (6 tests)
  Test Files  5 passed (5)
  Tests  27 passed (27)
  ```
- **Self-Correction & Cycle Verification:**
  - `tests/graph/review-graph.test.ts` asserts:
    1. Happy path traverses all nodes sequentially to report.
    2. Self-correction cycle triggered when `validate` catches an out-of-diff finding; hint sent to `llm_triage`, second attempt succeeds.
    3. Bounded retry stops at `maxAttempts` (3), marks `llm_triage` degraded, drops invalid findings, and continues to report.
    4. Static analysis tool timeout retry doubles `timeoutMs` for Bandit and succeeds.
    5. Docker unavailable failure recovers on host backend.
    6. Graph never throws unhandled errors when dependencies fail; gracefully degrades to report.
- **Full Quality Gate:**
  `npm run check && npm run check:types && npm test && npm run build`
  - 48 test files passed, 283 tests passed (3 skipped integration tests).
  - TypeScript strict typecheck passed with zero errors.
  - Oxlint and oxfmt checks passed with zero errors.
  - `dist/server.mjs` built successfully.

