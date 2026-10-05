# E0 — Foundation

**Unlocks:** nothing on its own; every other epic depends on it.
**Effort:** ~0.5 day. **Prereqs:** none.

## Why
- Every stage (AST checks, Bandit, Ruff, LLM) must speak one `Finding` shape so the graph can merge, dedupe, validate and report them.
- The review workflow currently ignores its payload (`src/workflows/review.ts:38` calls `resolveReviewConfig(undefined, process.env)`), so `prUrl` and feature flags can't be passed in.
- Every epic needs realistic vulnerable code to test against.

---

## E0.1 Restore deleted files [x]
`README.md` and `AGENTS.md` show as ` D` (deleted, unstaged) in `git status`.
- Confirm with the user that the deletion was unintentional. If so, run `git restore README.md AGENTS.md`.
- **Accept:** both files exist and `git status` no longer lists them as deleted.

## E0.2 Shared `Finding` model [x]
**File:** `src/review/findings.ts` (new)

```ts
import { createHash } from 'node:crypto'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type FindingSource = 'bandit' | 'ruff' | 'ast-grep' | 'tsc' | 'oxlint' | 'llm'
export type FindingStatus = 'candidate' | 'confirmed' | 'dismissed'

export interface Finding {
  id: string                 // stable hash, see findingId()
  source: FindingSource
  ruleId: string             // e.g. B602, S608, py-eval-sink, llm
  severity: Severity
  confidence?: 'high' | 'medium' | 'low'
  file: string               // repo-relative
  startLine: number
  endLine: number
  message: string
  cwe?: string               // "CWE-78"
  symbol?: string            // enclosing function/class from E2
  status: FindingStatus
  rationale?: string         // LLM triage reason (confirm/dismiss)
  fix?: { replacement: string; startLine: number; endLine: number } // for E5 patches
}

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

export const findingId = (f: Pick<Finding, 'source' | 'ruleId' | 'file' | 'startLine'>) =>
  createHash('sha1').update(`${f.source}|${f.ruleId}|${f.file}|${f.startLine}`).digest('hex').slice(0, 12)

/** Same file + overlapping lines + same CWE (or same rule) → keep highest severity, merge sources in message. */
export const dedupeFindings = (all: Finding[]): Finding[] => { /* implement */ }

/** Keep only findings that intersect the changed line ranges of the diff. */
export const onlyChanged = (all: Finding[], changed: Map<string, LineRange[]>): Finding[] => { /* implement */ }
```

- Also add a valibot schema `FindingSchema` in the same file. LLM output (E4) is validated against it.
- **Tests:** `tests/review/findings.test.ts` covers id stability, dedupe of a Bandit B602 and a Ruff S602 on the same line into a single finding, and `onlyChanged` boundaries (start, end, and pure deletions).
- **Accept:** tests pass, and nothing else in the codebase changes.

## E0.3 Workflow honors its payload [x]
**Files:** `src/workflows/review.ts`, `src/review/config.ts`, `tests/workflows/review.test.ts`

1. Read the flue types (`node_modules/@flue/runtime`) to confirm what `run()` receives. The input is expected to arrive as `input` or `payload`.
2. Replace `input: v.object({})` with a permissive schema that has optional fields: `platform, workspace, prUrl, baseSha, headSha, model, staticAnalysis, sandbox, astChecks, hitlMode`. Valibot `object()` ignores unknown keys, so old callers keep working.
3. Call `resolveReviewConfig(input, process.env)`.
4. The agent initializer only gets `env` (see the comment in `src/agents/reviewer.ts`). Anything the agent needs from the payload must be copied into `process.env` **before** `harness.session()`. Write a small `applyPayloadToEnv(cfg)` helper and document why it exists.
- **Accept:** `flue run review --payload '{"platform":"local","baseSha":"HEAD~1","headSha":"HEAD"}'` reviews the last commit instead of staged changes. A test asserts that `resolveReviewConfig` gets called with the payload.

## E0.4 Feature flags [x]
**Files:** `src/review/config.ts`, `action.yml`, `docs/CONFIGURATION.md`

Add to `ReviewPayload` and `ReviewConfig`. Precedence is payload, then env, then default.

| Field | Env | Default | Used by |
|---|---|---|---|
| `staticAnalysis: boolean` | `CodeSentinel_STATIC_ANALYSIS` | `true` | E3 |
| `sandbox: 'docker' \| 'host' \| 'auto'` | `CodeSentinel_SANDBOX` | `auto` (docker if `docker info` works) | E3 |
| `analyzerTimeoutMs: number` | `CodeSentinel_ANALYZER_TIMEOUT_MS` | `60000` | E3 |
| `astChecks: boolean` | `CodeSentinel_AST_CHECKS` | `true` | E2 |
| `hitlMode: 'off' \| 'suggest' \| 'interactive'` | `CodeSentinel_HITL_MODE` | `suggest` | E5 |
| `maxAttempts: number` | `CodeSentinel_MAX_ATTEMPTS` | `3` | E4 |
| `prUrl?: string` | `CodeSentinel_PR_URL` | — | E1 |

- Add matching `action.yml` inputs and env mappings next to the existing ones (pattern at `action.yml` around lines 75–105). **This is a CI edit, so it needs approval.**
- **Accept:** config tests cover precedence for each flag.

## E0.5 Vulnerable fixture repo [x]
**Dir:** `tests/fixtures/vuln-repo/` holds the plain source files. Do **not** commit a nested `.git`.

Write `tests/helpers/makeRepo.ts`. It copies the fixture into a tmp dir, runs `git init`, commits a "base" version (the clean files), then applies the "head" version (the vulnerable edits) as a second commit, and returns `{dir, baseSha, headSha}`.

Seed these vulns in the **head** version. Each one sits on a changed line:

| File | Vuln | Expected detectors |
|---|---|---|
| `app/run.py` | `subprocess.call(cmd, shell=True)` with user input | Bandit B602, Ruff S602, ast-grep |
| `app/store.py` | `pickle.loads(request.data)` | Bandit B301, Ruff S301 |
| `app/config.py` | `password = "hunter2"` | Bandit B105, Ruff S105 |
| `app/db.py` | `cursor.execute("SELECT * FROM u WHERE id=" + uid)` | Bandit B608, Ruff S608, ast-grep |
| `app/calc.py` | `eval(expr)` | Bandit B307, Ruff S307, ast-grep |
| `app/yaml_load.py` | `yaml.load(data)` without Loader | Bandit B506, Ruff S506 |
| `app/regress.py` | call to an undefined name (regression) | Ruff F821 |
| `web/exec.ts` | `` exec(`ls ${req.query.dir}`) `` | ast-grep |
| `web/eval.ts` | `new Function(userCode)` | ast-grep |
| `web/broken.ts` | type error introduced | tsc |

Also include 2–3 **clean** changed files to measure false positives. E7.1 writes the labels file (`tests/fixtures/vuln-repo.labels.json`).

- **Accept:** `makeRepo()` works in a test, and `git diff base...head` lists all of the files above.

## E0.6 Approvals [x]
Show the user the dependency table and the CI-edit list from `00-INDEX.md`, and record their approval in this file under `## Approvals`.

## Approvals
The repository owner has granted explicit approval for:
- Dependencies: `@langchain/langgraph`, `@langchain/core`, `zod`, `@ast-grep/napi`, `@ast-grep/lang-python`, `@langfuse/tracing`, `@langfuse/otel`, `@opentelemetry/sdk-node`. (Python tools `bandit` and `ruff` go in the Docker image / pipx only, never package.json).
- CI workflow files: `action.yml`, `.github/workflows/CodeSentinel-mention.yml`, `.github/workflows/pr.yml` for the planned changes.

## Deviations
1. **Flue CLI parameter**: In `@flue/cli`, workflow runs accept input via `--input <json>` rather than `--payload <json>`. `src/workflows/review.ts` was made to transparently accept both `ctx.input` and `ctx.payload`.
2. **Global libvips / sharp npm install**: On systems with globally installed `vips-cpp` (e.g. Arch/Fedora), sharp defaults to compiling from source unless `SHARP_IGNORE_GLOBAL_LIBVIPS=1` is provided. Running install with `SHARP_IGNORE_GLOBAL_LIBVIPS=1` succeeded and verified `patch-package`.
3. **Tool configuration cache**: Added `.commandcode/` to `.gitignore` and `.oxfmtrc.json` ignore list to keep formatting checks clean.

## Done when
E0.1–E0.6 are ticked, and `npm run check && npm run check:types && npm test` is green.

## Verification
- **E0.1**: `git restore README.md AGENTS.md` executed. Both files are restored and tracked.
- **E0.2**: `tests/review/findings.test.ts` (10 tests) passed. Verified ID stability, deduplication of Bandit B602 and Ruff S602 into single finding with highest severity, onlyChanged boundary conditions and pure deletion filtering, and valibot schema validation.
- **E0.3**: `tests/workflows/review.test.ts` passed. Verified `ReviewWorkflowInputSchema` accepts permissive fields, `resolveReviewConfig` receives payload, `getChangedFiles` receives payload config, and `applyPayloadToEnv` synchronizes config into process.env.
- **E0.4**: `tests/review/config.test.ts` (12 tests) passed. Verified precedence (payload > env > default) for all feature flags (`staticAnalysis`, `sandbox`, `analyzerTimeoutMs`, `astChecks`, `hitlMode`, `maxAttempts`, `prUrl`). `action.yml` inputs and env mappings added.
- **E0.5**: `tests/helpers/makeRepo.test.ts` passed. Verified `makeRepo()` creates git repository, commits base clean files and head vulnerable edits, and `git diff base...head` contains all 13 seeded vulnerable and clean files.
- **E0.6**: Approvals recorded above.
- **Quality Gate**:
  - `npm run check`: 0 warnings, 0 errors, all files formatted.
  - `npm run check:types`: tsc --noEmit succeeded with 0 errors.
  - `npm test`: 25 test files passed, 145 tests passed.
  - `npm run build`: `dist/server.mjs` built successfully.
  - Smoke test: server booted and listened on port 38271.
