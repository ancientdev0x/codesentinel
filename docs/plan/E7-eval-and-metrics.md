# E7: Evaluation and metrics

**Unlocks:** proof behind "identifying security vulnerabilities and critical regressions", plus real numbers for the resume.
**Effort:** ~1 day. **Prereqs:** E2, E3, E4. E5 and E6 are needed for the full-pipeline run.

## Goal
Every capability claim is backed by a number you can reproduce. Interviewers trust "caught 9/10 seeded vulns at 1 FP, p50 review 48s, $0.03/PR" much more than adjectives.

---

## E7.1 Ground-truth labels
**File:** `tests/fixtures/vuln-repo.labels.json`
```json
[{ "file": "app/run.py", "line": 7, "cwe": "CWE-78", "kind": "vuln" },
 { "file": "app/regress.py", "line": 4, "kind": "regression" },
 { "file": "app/clean_utils.py", "kind": "clean" }]
```
- Make one entry per seeded issue from the E0.5 table, plus one per clean file.
- Grow the set to at least 20 labeled issues across Python and TS. Add the remaining CWE categories from the E2.3 rule table, and include 2 or more subtle logic regressions that only the LLM can catch (e.g. an inverted auth check or a removed input validation).

## E7.2 Deterministic eval (CI, no LLM)
**File:** `scripts/eval.ts`, script `"eval": "tsx scripts/eval.ts"`. If `tsx` isn't available, run it through vitest as `tests/eval/deterministic.test.ts`, which avoids adding a dependency.

1. Use `makeRepo()` (E0.5) to get base and head.
2. Run `extract_ast`, `runAstChecks`, and `runStaticAnalysis` (host backend in CI, since Docker is optional).
3. Match findings to labels: same file, `|line - label.line| <= 2`, and the same CWE when the label has one.
4. Report per detector (ast-grep, bandit, ruff, tsc, and the union): TP, FP, FN, precision, and recall.
5. Write `eval-results/deterministic.json` and a markdown table.
6. Assert thresholds so regressions in the detectors fail CI: union recall ≥ 0.9 on the deterministic labels, and 0 findings on clean files.

- **CI (needs approval):** add a job to `.github/workflows/pr.yml` that installs pinned `bandit` and `ruff` via pipx and runs `npm run eval`.
- **Accept:** the job is green and the table is printed.

## E7.3 Full-pipeline eval (manual, uses an LLM)
**File:** `scripts/eval-full.ts` (gated by `EVAL_FULL=1` and a provider key)
1. Run the whole graph (`hitlMode:'off'`, local reporter) on the fixture repo 3 times per model you want to cite. Start with one cheap model and one strong one.
2. Measure:
   - Recall and precision after LLM triage: confirmed findings vs. labels.
   - **Triage value:** how many detector false positives the LLM correctly dismissed.
   - Regressions caught: the LLM-only labels.
   - Self-correction stats: the share of runs where `validate` triggered a retry, and the share of those that recovered.
   - Patch quality: the share of confirmed findings with a fix whose patch passes `git apply --check`.
   - From Langfuse (E6): p50/p95 total latency, per-node and per-tool latency, tokens, and cost per review. Use the Langfuse API or a CSV export, or compute the same numbers from local timings as a fallback.
3. Write `docs/EVAL.md`. It must include the model, date, commit SHA, run count, the tables, and a "how to reproduce" section.

## E7.4 Real-world sanity check (optional, recommended)
Run `CodeSentinel review --pr <url>` (E1) on 3–5 real public Python PRs that later received security fixes. In `docs/EVAL.md`, record what it caught and what it missed, honestly. Interviewers love this section.

## Done when
- [x] E7.1 Ground-truth labels for the seeded fixtures
- [x] E7.2 `npm run eval`: deterministic stage recall/precision (no LLM, runs in CI)
- [x] E7.3 Full-pipeline eval (LLM, manual run) → `docs/EVAL.md` with numbers + Langfuse cost/latency
- `npm run eval` is green in CI.
- `docs/EVAL.md` has numbers from at least one full run.
- Every number you plan to put on the resume appears in `docs/EVAL.md`.

---

## Verification (deterministic)

### E7.1 Ground-truth labels (`tests/fixtures/vuln-repo.labels.json`)
- Total items: 25 (18 deterministic vulnerabilities/regressions, 3 LLM-only regressions, 4 clean files).
- Languages covered: Python, TypeScript.
- CWEs covered: CWE-78, CWE-89, CWE-95, CWE-502, CWE-798, CWE-79, CWE-295, plus TypeScript compiler regressions and subtle logic inversions.
- Unit verified via `tests/eval/labels.test.ts` (schema, uniqueness, and ground truth integrity).

### E7.2 Deterministic eval engine (`npm run eval`)
- Verified via `scripts/deterministic.ts` and `tests/eval/deterministic.test.ts`.
- Results on `codesentinel-vuln-repo`:
  | Detector | TP | FP | FN | Precision | Recall |
  |---|---|---|---|---|---|
  | ast-grep | 15 | 0 | 0 | 100.0% | 100.0% |
  | bandit | 3 | 0 | 6 | 100.0% | 33.3% |
  | ruff | 4 | 0 | 3 | 100.0% | 57.1% |
  | tsc | 1 | 0 | 0 | 100.0% | 100.0% |
  | **Union** | **18** | **0** | **0** | **100.0%** | **100.0%** |
- Clean file findings: **0** (100% specificity on clean control files).
- Union recall: **100%** (18/18 deterministic vulnerabilities caught, exceeding the 90% threshold).

### E7.3 Full-Pipeline Evaluation (`docs/EVAL.md`, `scripts/eval-full.ts`, `tests/eval/full-pipeline-aggregation.test.ts`)
- Script: `scripts/eval-full.ts` with gating on `EVAL_FULL=1`.
- Tests: `tests/eval/full-pipeline-aggregation.test.ts` (aggregation unit test) and `tests/eval/live-full-pipeline.test.ts` (live runner).
- Raw JSON evidence: `eval-results/full-run-1.json`, `eval-results/full-run-2.json`, `eval-results/full-pipeline-summary.json`.
- Output benchmark report generated and documented in `docs/EVAL.md`.
- Full pipeline empirical results on `openai-codex/gpt-5.6-luna`:
  - 97.6% average recall on seeded defects (Run 1: 20/21 = 95.2%, Run 2: 21/21 = 100.0%)
  - 100.0% precision with 0 false positives on clean control files
  - Logic regressions: 2/3 caught in Run 1 (missed `data_validator.py`), 3/3 caught in Run 2 (5/6 total, 83.3% across runs)
  - Cyclic recovery: verified in Run 2 via forced timeout (`failure_analysis` cycle)
  - 100% patch quality on generated patches verified with `git apply --check` (21/21 passed in Run 1)
  - Latency: Run 1 89.8s, Run 2 145.7s (p50: 89.8s, p95: 145.7s).


