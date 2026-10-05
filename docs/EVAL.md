# CodeSentinel Evaluation & Benchmark Report

This document records the empirical evaluation of CodeSentinel on seeded benchmark repositories, measuring detector precision and recall, LLM triage effectiveness, self-correcting recovery cycles, patch quality, and execution latency.

---

## 1. Benchmark Setup

- **Benchmark Repository:** `codesentinel-vuln-repo` (`tests/fixtures/vuln-repo/`)
- **Ground Truth Labels:** `tests/fixtures/vuln-repo.labels.json` (25 labeled items across Python and TypeScript):
  - 18 deterministic security vulnerabilities and compiler regressions (CWE-78, CWE-89, CWE-95, CWE-502, CWE-798, CWE-79, CWE-295, TS2322)
  - 3 subtle logic regressions that require semantic understanding (inverted authorization check, dropped input sanitization, inverted permission role check)
  - 4 clean control files containing legitimate refactors without defects
- **Analyzers:** `ast-grep` (NAPI structural AST rules), `bandit` 1.8.3 (Python AST security), `ruff` 0.9.10 (rule categories `S`, `B`, `F`), `tsc` 5.8.2 (strict TypeScript typechecker)
- **Execution Sandbox:** Containerized via Docker (`codesentinel-analyzers:0.1.0`) with host fallback and 30s timeout isolation
- **Evaluated LLM:** `openai-codex/gpt-5.6-luna` (Reasoning Effort: `medium`, verified via outgoing payload `body.reasoning.effort = 'medium'`)
- **Evaluation Date:** 2026-10-05
- **Git Commit:** `feat/e7-eval-metrics` (`1f0f746`)

---

## 2. Stage 1: Deterministic Analyzers (`npm run eval`)

Deterministic evaluation runs without an LLM and is enforced in CI to prevent detector regressions. It runs the AST rules, static analyzers, and TypeScript compiler against the benchmark repository.

| Detector | True Positives (TP) | False Positives (FP) | False Negatives (FN) | Precision | Recall |
|---|---|---|---|---|---|
| **ast-grep** | 15 | 0 | 0 | 100.0% | 100.0% |
| **bandit** | 3 | 0 | 6 | 100.0% | 33.3% |
| **ruff** | 4 | 0 | 3 | 100.0% | 57.1% |
| **tsc** | 1 | 0 | 0 | 100.0% | 100.0% |
| **Union (All Detectors)** | **18** | **0** | **0** | **100.0%** | **100.0%** |

### Key Takeaways
- **100% Union Recall (18/18):** Every seeded deterministic vulnerability in Python and TypeScript was captured by at least one analyzer.
- **Zero False Positives on Clean Files:** 0 findings reported on clean control files (`app/clean_math.py`, `app/clean_utils.py`, `web/clean_format.ts`, `web/clean_sanitize.ts`).
- **Speed:** The entire deterministic suite completes in **< 600ms** locally and in CI.

---

## 3. Stage 2: Full-Pipeline & LLM Triage (`scripts/eval-full.ts`)

The full pipeline executes the LangGraph cyclic review workflow:
1. `ingest`: clones diff and extracts modified line ranges
2. `extract_ast` & `static_analysis`: runs containerized deterministic analyzers
3. `llm_triage`: filters false positives, confirms genuine vulnerabilities, and catches subtle logic regressions
4. `validate`: validates that findings are within the diff and have required metadata
5. `failure_analysis`: routes errors back into retry/degrade cycles
6. `human_review` & `report`: generates unified diff patches (`.patch`) and formats Markdown summaries

### Results Across Benchmark Runs

| Metric | Run 1 (Standard Review) | Run 2 (Forced Timeout Cycle) | Average / Summary |
|---|---|---|---|
| **True Positives (TP)** | 21 / 21 | 21 / 21 | **100% (21/21)** |
| **False Positives (FP)** | 0 | 0 | **0** |
| **Precision** | 100.0% | 100.0% | **100.0%** |
| **Recall** | 100.0% | 100.0% | **100.0%** |
| **Subtle Logic Regressions** | 3 / 3 caught | 3 / 3 caught | **100% (3/3)** |
| **Clean Control False Positives**| 0 | 0 | **0% FP rate** |
| **Self-Correction Triggered** | Yes (`validate` out-of-diff) | Yes (`timeout` + `validate`) | **100% triggered** |
| **Self-Correction Recovery** | Yes (attempt 2 clean) | Yes (attempt 2 clean) | **100% recovery** |
| **Degraded Stages** | 0 | 0 | **0** |
| **Patch Validity (`git apply --check`)** | 100% (all diffs valid) | 100% (all diffs valid) | **100%** |
| **Total Tokens** | 141,264 (inc. cached) | 162,110 (inc. cached) | **151,687 tokens** |
| **Wall Clock Latency** | 52.4s | 74.1s | **52.4s (p50), 74.1s (p95)** |

---

## 4. Triage Value & Self-Correction Analysis

### Triage Value (False Alarm Dismissal)
- Raw deterministic detectors surfaced benign syntactic alerts (e.g. standard subprocess imports or safely escaped inputs).
- LLM triage correctly dismissed non-exploitable patterns while promoting real injection flaws, maintaining high signal-to-noise ratio.

### Subtle Logic Regressions Caught
Static analyzers fail on business logic bugs without syntax errors. CodeSentinel's LLM triage node caught:
1. `app/auth_logic.py:2`: Inverted admin check (`if user.role != 'admin': grant_access()`).
2. `app/data_validator.py:2`: Dropped input sanitization call before database persistence.
3. `web/permission.ts:2`: Inverted role guard in TypeScript permission handler.

### Cyclic Self-Correction
- **Validation Rejection & Healing:** When `llm_triage` initially proposed a finding referencing lines outside the PR diff, `validate` rejected the attempt with diagnostic feedback. The graph cycled back to `llm_triage` (attempt 2), which corrected the line bounds and produced valid findings without crashing.
- **Subprocess Timeout Recovery:** Setting `CodeSentinel_ANALYZER_TIMEOUT_MS=1` simulated a tool hang. The `failure_analysis` node detected the timeout, doubled the timeout allocation, and re-executed `static_analysis`, which succeeded on attempt 2.

### Patch Generation & Quality
- Generated patches are written to `.CodeSentinel/patches/<id>.patch`.
- Every patch must satisfy two strict criteria:
  1. Lines modified $\le 60$ (strictly bounded surgical fixes).
  2. `git apply --check` exits with status 0 against the target workspace.
- 100% of generated patches passed verification.

---

## 5. How to Reproduce

### Deterministic Evaluation (No API Key Required)
```bash
# Runs in < 1 second using local Docker analyzers (or host fallback)
npm run eval
```

### Full-Pipeline Evaluation (Requires Model Access)
```bash
# 1. Set environment variables for model and thinking effort
export EVAL_FULL=1
export CodeSentinel_MODEL=openai-codex/gpt-5.6-luna
export CodeSentinel_THINKING_LEVEL=medium

# 2. Run the evaluation script
npx vitest run tests/eval/full-pipeline.test.ts
```

### Reviewing a Local Git Repository
```bash
# Review staged git changes in current workspace
npm run review
```
