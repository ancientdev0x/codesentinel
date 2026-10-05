# CodeSentinel Evaluation & Benchmark Report

This document records the empirical evaluation of CodeSentinel on seeded benchmark repositories, measuring detector precision and recall, LLM triage effectiveness, self-correcting recovery cycles, patch quality, and execution latency. All metrics are sourced strictly from raw benchmark outputs in `eval-results/`.

---

## 1. Benchmark Setup

- **Benchmark Repository:** `codesentinel-vuln-repo` (`tests/fixtures/vuln-repo/`)
- **Ground Truth Labels:** `tests/fixtures/vuln-repo.labels.json` (25 labeled items across Python and TypeScript):
  - 18 deterministic security vulnerabilities and compiler regressions (CWE-78, CWE-89, CWE-95, CWE-502, CWE-798, CWE-79, CWE-295, TS2322)
  - 3 subtle logic regressions requiring semantic understanding (inverted authorization check, dropped input sanitization, inverted permission role check)
  - 4 clean control files containing legitimate refactors without defects
- **Analyzers:** `ast-grep` (NAPI structural AST rules), `bandit` 1.8.3 (Python AST security), `ruff` 0.9.10 (rule categories `S`, `B`, `F`), `tsc` 5.8.2 (strict TypeScript typechecker)
- **Execution Sandbox:** Containerized via Docker (`codesentinel-analyzers:0.1.0`) with host fallback and timeout isolation
- **Evaluated LLM:** `openai-codex/gpt-5.6-luna` (Reasoning Effort: `medium`, verified via outgoing payload `body.reasoning.effort = 'medium'`)
- **Evaluation Date:** 2026-10-05
- **Git Branch:** `feat/e8-docs-and-resume`

---

## 2. Stage 1: Deterministic Analyzers (`npm run eval`)

Deterministic evaluation runs without an LLM and is enforced in CI to prevent detector regressions. Source data: `eval-results/deterministic.json`.

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

## 3. Stage 2: Full-Pipeline Benchmark (`eval-results/full-run-1.json`, `eval-results/full-run-2.json`, `eval-results/full-run-3.json`)

The full pipeline executes the LangGraph cyclic review workflow:
1. `ingest`: clones diff and extracts modified line ranges
2. `extract_ast` & `static_analysis`: runs containerized deterministic analyzers
3. `llm_triage`: filters false positives, confirms genuine vulnerabilities, and catches subtle logic regressions
4. `validate`: validates that findings are within the diff and have required metadata
5. `failure_analysis`: routes errors into retry/degrade cycles
6. `human_review` & `report`: generates unified diff patches (`.patch`) and formats Markdown summaries

### Empirical Results Across Live Benchmark Runs

Source data: `eval-results/full-run-1.json` (Run 1: standard review), `eval-results/full-run-2.json` (Run 2: forced timeout cycle), and `eval-results/full-run-3.json` (Run 3: forced timeout cycle with corrected node sequence and degraded tracking).

| Metric | Run 1 (Standard Review) | Run 2 (Forced Timeout Cycle) | Run 3 (Forced Timeout + Corrected Tracking) | 3-Run Benchmark Summary (Runs 1, 2 & 3) |
|---|---|---|---|---|
| **True Positives (TP)** | 20 / 21 | 21 / 21 | 20 / 21 | **95–100% recall (20.3 / 21, 96.8% avg)** |
| **False Positives (FP)** | 0 | 0 | 0 | **0 (100.0% precision)** |
| **Duplicate Detections** | 23 | 15 | 16 | **18 avg** |
| **Total Confirmed Findings** | 43 | 36 | 36 | **38.3 avg** |
| **False Negatives (FN)** | 1 | 0 | 1 | **0.7 avg** |
| **Precision** | 100.0% | 100.0% | 100.0% | **100.0%** |
| **Recall** | 95.2% (20/21) | 100.0% (21/21) | 95.2% (20/21) | **95–100% recall (96.8% avg: 20/21, 21/21, 20/21)** |
| **Subtle Logic Regressions** | 2 / 3 caught (missed `data_validator.py`) | 3 / 3 caught | 2 / 3 caught (missed `data_validator.py`) | **7 of 9 caught across 3 runs (77.8%)** |
| **Clean Control False Positives**| 0 | 0 | 0 | **0% FP rate** |
| **Self-Correction Triggered** | No (all attempt 1) | Yes (`failure_analysis` cycle) | Yes (`failure_analysis` cycle) | **66.7% triggered (2 of 3 benchmark runs)** |
| **Self-Correction Recovered** | N/A | **False** (exhausted attempts, degraded) | **False** (exhausted attempts, degraded) | **0% (not a successful recovery)** |
| **Real Node Sequence** | ingest → extract_ast → static_analysis → llm_triage → validate → human_review → report | Deduplicated in old recorder | ingest → extract_ast → static_analysis → failure_analysis → static_analysis → failure_analysis → llm_triage → validate → human_review → report | Cycles and retry loops visible |
| **Degraded Stages** | 0 (`[]`) | 1 (`['llm_triage']`) | 4 (`['bandit', 'ruff', 'tsc', 'static_analysis']`) | Degraded stage tracking verified |
| **Patch Validity (`git apply --check`)** | 21 / 21 (100% valid diffs) | 0 generated | 0 generated | **100% of generated patches valid** |
| **Tokens (Total)** | 35,559 | 355,805 | 56,039 | Measured via OTel generation tokens |
| **Wall Clock Latency** | 89.8s (89,775 ms) | 145.7s (145,660 ms) | 74.9s (74,938 ms) | **89.8s median (89.8s / 145.7s / 74.9s, ~90s median per review)** |

---

## 4. Honest Evaluation Analysis

### Triage Value & Detection Quality
- Raw deterministic detectors surfaced multiple alerts per vulnerability (e.g. both `ast-grep` and `bandit` flagging the same SQL query or exec pattern).
- LLM triage confirmed genuine defect locations and eliminated false positives against clean controls, yielding 100.0% precision across all runs.
- Duplicate detections across multiple tools (23 in Run 1, 15 in Run 2, 16 in Run 3) are counted separately from unique true positives to ensure precision and recall reflect distinct seeded issues.

### Subtle Logic Regressions Caught
Static analyzers cannot detect business logic regressions that contain valid syntax. CodeSentinel's LLM triage node evaluated the 3 seeded semantic logic defects:
1. `app/auth_logic.py:2`: Inverted admin check (`if user.role != 'admin': grant_access()`) — **caught** in all runs.
2. `web/permission.ts:5`: Inverted role guard in TypeScript permission handler (`if (user.role !== 'admin') return true`) — **caught** in all runs.
3. `app/data_validator.py:2`: Dropped input sanitization call before database persistence — missed in Run 1 and Run 3, **caught in Run 2**.

Across the 3 live benchmark runs (Runs 1, 2 & 3), 7 out of 9 logic regression opportunities were successfully detected (Run 1: 2/3, Run 2: 3/3, Run 3: 2/3).

### Execution Under Timeout (Honest Self-Correction Account)
- In Run 2 and Run 3, `CodeSentinel_ANALYZER_TIMEOUT_MS=1` forced tool timeouts.
- **Run 2 Result:** Timeout forced; static analysis degraded, LLM triage exhausted 3 attempts and degraded; review still completed with 21/21 via LLM. This is **not a successful recovery** (`selfCorrection.recovered = false`).
- **Run 3 Result:** Demonstrates corrected real sequence logging with cycles (`ingest` → `extract_ast` → `static_analysis` → `failure_analysis` → `static_analysis` → `failure_analysis` → `llm_triage` → `validate` → `human_review` → `report`) and complete degraded tracking (`['bandit', 'ruff', 'tsc', 'static_analysis']`). Review completed with 20/21 via LLM. Not a successful recovery (`selfCorrection.recovered = false`).

### Patch Generation & Quality
- Generated patches are written to `.CodeSentinel/patches/<id>.patch`.
- In Run 1, 21 patches were generated. Every patch was tested using `git apply --check` against the repository workspace:
  - 21 / 21 (100%) passed `git apply --check`.
  - All patches adhered to the surgical bounds rule ($\le 60$ lines modified).

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
npm run eval:full
# or via vitest:
npx vitest run tests/eval/live-full-pipeline.test.ts
```

### Reviewing a Local Git Repository
```bash
# Review staged git changes in current workspace
npm run review
```
