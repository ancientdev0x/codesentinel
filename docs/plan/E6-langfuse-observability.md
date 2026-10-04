# E6 — Langfuse observability: tool latency and tokens

**Unlocks (C4b):** "tracking tool latency and tokens using strict Langfuse pipelines".
**Effort:** about 1 day. **Prereqs:** E0. It can run in parallel with E1–E3; E4 and E5 must use its helpers.

## Current state
`src/common/telemetry.ts` sends a single anonymous fire-and-forget POST (`review_started` / `qa_started`). It records no tokens, no latency and no spans.

## Goal
Each review becomes one Langfuse trace:

```
trace: review  (repo, pr, model, run_id, platform)
 ├─ span: node.ingest
 ├─ span: node.extract_ast
 ├─ span: node.static_analysis
 │   ├─ tool: subprocess.bandit   (backend, exit, timeout?, duration)
 │   └─ tool: subprocess.ruff
 ├─ span: node.llm_triage  (attempt=1)
 │   ├─ generation: llm  (model, usageDetails{input,output,cache_read,…}, latency)
 │   ├─ tool: read / grep / record_finding / triage_finding / run_static_analysis …
 ├─ span: node.validate → node.failure_analysis → node.llm_triage (attempt=2) …   ← cycles are visible
 ├─ span: node.human_review   (+ later: score "patch_approved" from E5.4)
 └─ span: node.report
```

**Verify the SDK before coding.** The current JS SDK is OpenTelemetry-based:
- `@langfuse/tracing`: `startActiveObservation`, `startObservation`, with `asType: 'tool' | 'generation' | 'span'`.
- `@langfuse/otel`: `LangfuseSpanProcessor`.
- `@opentelemetry/sdk-node`.

Usage is recorded with `generation.update({ usageDetails: { input, output, ... } })`, and spans are flushed with `langfuseSpanProcessor.forceFlush()`. Check Context7 `/langfuse/langfuse-docs` for the installed version; v4 and v5 differ slightly.

---

## E6.1 Bootstrap
**File:** `src/observability/langfuse.ts`
```ts
let processor: LangfuseSpanProcessor | undefined
export const initTracing = (env) => {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return false   // fully no-op when unset
  processor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl: env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com', environment: env.CodeSentinel_ENV ?? 'ci' })
  new NodeSDK({ spanProcessors: [processor] }).start()
  return true
}
export const flushTracing = async () => { await processor?.forceFlush() }
```
- Call `initTracing` once per process, at workflow start. Call `flushTracing` in a `finally` in `review.ts`, so a failed review still sends its trace.
- **Masking:** set the processor's mask or redaction option, if the SDK has one. Otherwise sanitize before `update()`. Apply it to `GITHUB_TOKEN`, provider keys, and anything that matches `/(sk-|ghp_|github_pat_)[A-Za-z0-9_]+/`. Source code may reach input/output fields, so cap them at 8 KB each.
- Add `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` to the `action.yml` inputs and env (CI edit) and to `.env.example`.
- Keep the old `telemetry.ts` as it is (it is opt-out anonymous usage), or remove it if the user prefers. Ask.
- **Accept:** with keys unset, nothing is imported or started (assert in a test that `NodeSDK.start` was not called). With keys set, a trace appears in Langfuse (verify manually and attach a screenshot).

## E6.2 Trace + node spans
**File:** `src/observability/trace.ts`
```ts
export const withNodeSpan = <S>(name: string, fn: (s: S) => Promise<Partial<S>>) =>
  (s: S) => startActiveObservation(`node.${name}`, async (span) => {
    span.update({ input: summarizeState(s), metadata: { attempt: s.attempts?.[name] ?? 0 } })
    try { const out = await fn(s); span.update({ output: summarizeDelta(out) }); return out }
    catch (e) { span.update({ level: 'ERROR', statusMessage: String(e) }); throw e }
  })
```
- Wrap every node in `buildReviewGraph` (E4.5), and wrap the whole `graph.invoke` in `startActiveObservation('review', …)`.
- Call `updateActiveTrace({ name:'review', sessionId: prKey, tags:[platform, model], metadata:{repo, pr, runId} })`. Verify the function name in the installed SDK.
- `summarizeState` holds counts only, never full file contents.

## E6.3 Per-tool latency: `traced()` wrapper
**File:** `src/observability/tools.ts`
```ts
export const traced = <T extends ToolDef>(tool: T): T => ({
  ...tool,
  run: async (args) => {
    const obs = startObservation(`tool.${tool.name}`, { input: truncate(args.input) }, { asType: 'tool' })
    const t0 = performance.now()
    try { const out = await tool.run(args); obs.update({ output: truncate(out), metadata: { latencyMs: performance.now() - t0 } }).end(); return out }
    catch (e) { obs.update({ level: 'ERROR', statusMessage: String(e), metadata: { latencyMs: performance.now() - t0 } }).end(); throw e }
  },
})
```
- Apply it to the custom tools: `record_finding`, `triage_finding`, `run_static_analysis`, `suggest_change` (if it is kept), the QA tools, and MCP tools in `src/mcp/connect.ts`.
- **flue built-in tools** (`read`, `grep`, `bash`, `task`) are not ours to wrap. Read the flue `.d.ts` for an event or hook API (for example session events, `onToolCall`/`onToolResult`, or a stream of events from `session.prompt`). If one exists, open and close an observation per event pair. If none exists, record it under `## Deviations` and trace only the custom tools.

## E6.4 Tokens
**File:** `src/graph/nodes/llm-triage.ts`
- Inspect the return type of `session.prompt()` in `node_modules/@flue/runtime`. It probably has `usage` or `messages[].usage`.
- Wrap each prompt call in `startObservation('llm', { model: cfg.model, input: truncatedPrompt }, { asType: 'generation' })`.
- On completion, call `update({ output: truncatedText, usageDetails: { input, output, cache_read_input_tokens, cache_creation_input_tokens } }).end()`.
- If flue only exposes usage per turn through events, emit one generation per model turn instead. That is more accurate, so prefer it when available.
- If flue exposes **no** usage at all, stop and report this. Do not estimate tokens with a tokenizer and call it tracking.
- **Accept:** a manual run shows token counts and cost in Langfuse for each `llm_triage` attempt.

## E6.5 Subprocess spans
In `runIsolated` (E3.1), wrap the call in `startObservation('subprocess.<tool>', …, { asType: 'tool' })` with metadata `{ backend, exitCode, status, timeoutMs, durationMs }`. A timeout gets `level: 'WARNING'`, and a crash gets `ERROR`.

## E6.6 "Strict" pipeline guarantees
Turn "strict" into something you can check:
1. **Every tool is traced.** `tests/observability/coverage.test.ts` imports the tool arrays of `reviewer.ts`, `qa-lead.ts` and `healer.ts` and asserts that each `run` is wrapped. Mark wrapped tools with a symbol (`TRACED`) inside `traced()`.
2. **Every node is traced.** Build the graph with a fake processor (`InMemorySpanExporter` from `@opentelemetry/sdk-trace-base`, which is already a transitive dep of sdk-node; verify this) and run the happy path. Assert the span names equal the node sequence, and that a cycle produces two `node.llm_triage` spans with `attempt` set to 1 and 2.
3. **Metadata schema.** A valibot schema for trace metadata `{repo, pr, runId, model, platform}`. `withNodeSpan` validates it in tests.
4. **Flush guarantee.** A test checks that `flushTracing` runs on both the success and the throw path of `review.ts`.

## Done when
- E6.1–E6.6 are ticked.
- A Langfuse screenshot of one real review is committed to `docs/assets/langfuse-trace.png` and linked from the README. It must show the node spans, the tool latencies, the token usage, and one retry cycle.
