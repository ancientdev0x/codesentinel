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
- `npm run eval` is green in CI.
- `docs/EVAL.md` has numbers from at least one full run.
- Every number you plan to put on the resume appears in `docs/EVAL.md`.
