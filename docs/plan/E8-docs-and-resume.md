# E8 — Docs and resume sync

**Effort:** ~0.5 day. **Prereqs:** E1–E7 merged.

## E8.1 README
- Architecture section: the generated LangGraph diagram (E4.5) plus the stage table.
- Feature sections, each with a copy-pasteable command:
  - PR URL review: `CodeSentinel review --pr <url>`
  - AST fragments and rules: list the rules, and say how to add one
  - Sandboxed analyzers: the Docker isolation flags, the timeout config, and the host fallback
  - Self-correcting graph: the recovery table from E4.4
  - HITL patches: `--interactive`, and `/codesentinel apply|reject <id>`
  - Langfuse: the env vars and the trace screenshot
- Link to `docs/EVAL.md`.
- Update `AGENTS.md` "Project Structure" with the new dirs: `src/graph/`, `src/sandbox/`, `src/review/ast/`, `src/review/analyzers/`, `src/observability/`, `docker/`.
- Update `docs/CONFIGURATION.md` with all the E0.4 flags.

## E8.2 Resume wording
Fill this in only from the evidence. Each phrase must map to a row in the `00-INDEX.md` coverage table, and every number must come from `docs/EVAL.md`.

Template (replace `<…>` with real numbers):

> **CodeSentinel — Autonomous DevSecOps Review Agent** | TypeScript, LangGraph, Docker, Langfuse
> - Built multi-stage review pipelines ingesting git diffs and PR URLs, using ast-grep to extract changed functions/classes and run <N> AST security rules across Python and TypeScript.
> - Integrated Bandit and Ruff in network-less, read-only Docker sandboxes with hard timeouts; detected <x>/<y> seeded vulnerabilities and regressions at <p>% precision after LLM triage.
> - Architected a LangGraph cyclic state engine that orchestrates tool execution, classifies stage failures, and self-corrects via bounded retries (recovered <r>% of invalid-output runs).
> - Implemented human-in-the-loop patch approval (LangGraph interrupts + `/apply` PR commands) generating `git apply`-verified unified diffs; traced per-tool latency and token cost (~$<c>/PR) in Langfuse.

Checklist before using it:
- [ ] Every number is in `docs/EVAL.md` with a commit SHA.
- [ ] You can demo each bullet live in under 2 minutes: the PR URL run, the Docker flags, a retry visible in Langfuse, and `/apply`.
- [ ] Interview prep: answer the questions in `docs/RESUME_AUDIT.md` §7 out loud.
