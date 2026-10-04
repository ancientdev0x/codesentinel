# E3: Sandboxed static analysis (Bandit + Ruff) with timeout isolation

**Unlocks (C2):** "sandboxed utilities using timeout isolation leveraging Bandit with Ruff, identifying security vulnerabilities and critical regressions".
**Effort:** about 2 days. **Prereqs:** E0.2, E0.4, E0.5.

## Current state
- `local({cwd})` in `src/agents/reviewer.ts:31` runs real bash on the host.
- The review path has no timeouts: `src/review/diff.ts:115` and `src/qa/exec.ts:28`.
- There are no analyzers anywhere in the repo.
- Security coverage is a single prompt line in `src/review/instructions.ts:35`.

## Goal
- Run Bandit and Ruff against the changed Python files inside an isolated container with hard wall-clock limits.
- Add cheap regression signals: Ruff F/E9, plus `tsc` and oxlint on TS changes.
- Normalize all output to `Finding[]`.
- If any analyzer is missing, times out or crashes, the review still finishes.

---

## E3.1 Isolated runner
**File:** `src/sandbox/run.ts`
```ts
export interface RunSpec {
  tool: string                 // 'bandit' | 'ruff' | 'tsc' | 'oxlint'
  cmd: string; args: string[]  // argv only, NEVER a shell string
  cwd: string                  // workspace (mounted read-only in docker mode)
  timeoutMs: number
  maxOutputBytes?: number      // default 10 MiB
  okExitCodes?: number[]       // bandit/ruff exit 1 = "findings", not failure
}
export type RunResult =
  | { status: 'ok'; exitCode: number; stdout: string; stderr: string; durationMs: number }
  | { status: 'timeout'; durationMs: number }
  | { status: 'unavailable'; reason: string }          // ENOENT / image missing
  | { status: 'error'; exitCode: number | null; stderr: string; durationMs: number }

export const runIsolated = (spec: RunSpec, backend: 'docker' | 'host'): Promise<RunResult>
```
Host backend:
- Use `execFile(cmd, args, { cwd, timeout, killSignal: 'SIGKILL', maxBuffer, env: MIN_ENV })`.
- `MIN_ENV` is `{ PATH, HOME: tmp, LANG }` only. No API keys or `GITHUB_TOKEN` may leak to analyzers.
- Spawn with `detached: true` and kill the process group (`process.kill(-pid, 'SIGKILL')`) on timeout, so grandchildren die too.

Both backends:
- Classify failures: ENOENT becomes `unavailable`, `killed && signal==='SIGKILL'` becomes `timeout`.
- Time with `performance.now()`. E6.5 wraps this function in a Langfuse span.

- **Tests:** run `node -e "setTimeout(()=>{}, 10000)"` with `timeoutMs: 200` and expect `timeout` in under 1s. Also test that ENOENT gives `unavailable`, that exit 1 with `okExitCodes:[0,1]` gives `ok`, and that the env does not contain `GITHUB_TOKEN`.
- **Accept:** these tests pass.

## E3.2 Docker backend
**Files:** `src/sandbox/docker.ts`, `docker/analyzers.Dockerfile`

```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir bandit==<pin> ruff==<pin>   # pin current versions, record them here
RUN useradd -u 10001 -M analyzer
USER 10001
WORKDIR /src
```

The run command:
```
docker run --rm --name cs-<tool>-<rand>
  --network none --read-only --tmpfs /tmp:rw,size=64m
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 128 --memory 512m --cpus 1 --user 10001
  -v <workspace>:/src:ro -w /src
  codesentinel-analyzers:<version> <cmd> <args...>
```
- On timeout, run `docker kill cs-<tool>-<rand>` in addition to killing the CLI process. Killing the client alone leaves the container running.
- Backend selection when `cfg.sandbox==='auto'`: use docker if `docker image inspect codesentinel-analyzers:<v>` succeeds, or a `docker build` succeeds within 180s. Otherwise use host. Log the chosen backend once.
- Paths: analyzers see `/src/...`, so map them back to repo-relative paths in the adapters.
- **Tests:**
  - Unit test that `buildDockerArgs()` contains every isolation flag (snapshot).
  - Integration test, skipped unless `docker info` works (`it.runIf`): a container trying `curl`/`python -c "import socket; socket.create_connection(('1.1.1.1',80))"` fails, and a `sleep 30` run is killed at `timeoutMs`.
- **Accept:** the unit test passes, and the integration test passes locally (paste the output here).

## E3.3 Bandit adapter
**File:** `src/review/analyzers/bandit.ts`
- `bandit -f json -q -r <files...>` (only the changed `.py` files). Pass `okExitCodes: [0, 1]`.
- Map `results[]`:
  - `test_id` becomes `ruleId`.
  - `issue_severity` + `issue_confidence` become severity: HIGH+HIGH maps to `high`, and anything HIGH in a crypto/exec/deserialization rule maps to `critical`. Keep the mapping table in code.
  - `issue_cwe.id` becomes `CWE-<id>`.
  - `line_range` becomes start/end.
  - `issue_text` becomes `message`.
- Parse defensively. Invalid JSON gives `[]` plus a recorded error (which E4 failure_analysis consumes).
- **Tests:** a recorded JSON fixture (commit real Bandit output from the E0.5 repo) produces the expected findings.

## E3.4 Ruff adapter
**File:** `src/review/analyzers/ruff.ts`
- `ruff check --output-format json --select S,B,E9,F --no-cache --isolated <files...>`. Pass `okExitCodes: [0, 1]`.
  - `--isolated` ignores the target repo's config so results are deterministic. Note this as a choice.
- Map: `code` becomes `ruleId`. Map severity as follows:
  - S rules use the same table as Bandit (S602 is equivalent to B602).
  - F821/F811/E9 are `high` and tagged `regression`.
  - B rules are `medium`.
- `fix.edits` (when present) becomes `Finding.fix`, which E5 patches can reuse.
- **Tests:** fixture JSON produces the expected findings, F821 is tagged as a regression, and S602 dedupes against B602 (via E0.2).

## E3.5 TS regression signals
**File:** `src/review/analyzers/typescript.ts`
- Run this only if TS files changed **and** the workspace has a `tsconfig.json`.
- Run `npx --no-install tsc --noEmit -p <tsconfig> --pretty false` (timeout 120s) and parse `file(line,col): error TSxxxx: msg`.
- Keep only errors in changed files. Each becomes `source:'tsc'`, severity `high`, tagged `regression`.
- Optionally run `npx --no-install oxlint --format json <files>`.
- These run on the host with timeout isolation. They need the repo's node_modules, so the docker image doesn't apply. Document this.
- **Accept:** the fixture `web/broken.ts` produces one tsc finding.

## E3.6 `run_static_analysis` tool
**File:** `src/tools/run-static-analysis.ts`
- `defineTool` with valibot `{ paths: v.array(v.string()), tools: v.optional(v.array(v.picklist(['bandit','ruff','tsc']))) }`.
- Reject paths outside the workspace with a `path.resolve` plus `startsWith` check.
- Return a compact JSON list of findings so the agent can re-check a file after reasoning about it.
- Register it in `src/agents/reviewer.ts` tools. E6.3 wraps it.

## E3.7 Wiring
- **`src/review/analyzers/index.ts`:** `runStaticAnalysis(cfg, files): Promise<{findings, runs: RunResult[]}>`. It runs the analyzers with `Promise.allSettled` and never throws.
- **`action.yml` (CI edit, needs approval):** add a step `docker build -t codesentinel-analyzers:<v> -f "$GITHUB_ACTION_PATH/docker/analyzers.Dockerfile" "$GITHUB_ACTION_PATH/docker"`, guarded by `inputs.STATIC_ANALYSIS != 'false'`, with `continue-on-error: true`. Also add a fallback step `pipx install bandit==<pin> ruff==<pin>` for the host backend.
- **`src/review/instructions.ts:35`:** expand the Security rule. Pre-detected findings must each be **confirmed or dismissed with a reason**, which is the "triage". Cover the CWE categories (injection, deserialization, secrets, SSRF, path traversal, authz) and "regressions: removed checks, changed error handling, broken call sites".
- **`src/common/formatting/summary.ts`:** add an "Analyzer report" table with tool, backend, status, findings, duration, and confirmed/dismissed counts.
- Until E4 lands, the call can sit in `review.ts` before `session.prompt`. E4 moves it into a node.

## Pitfalls
- Never build a shell string. Changed filenames are attacker-controlled in PRs.
- Use `--` before file arguments so that a file named `-rf.py` is not parsed as a flag.
- Exit code 1 from Bandit/Ruff means findings, not an error.
- Docker may not exist (macOS without Docker, some runners). The `auto` setting must fall back to the host and still print the backend used.

## Done when
E3.1–E3.7 are ticked. On the E0.5 fixtures, `runStaticAnalysis` finds every Python row in the fixture table (Bandit and Ruff) plus the tsc error, and the timeout test passes.
