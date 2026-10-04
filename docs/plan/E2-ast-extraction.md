# E2: AST fragment extraction and AST-level checks

**Unlocks (C1):** "extracting changed code fragments for strict AST-level checks".
**Effort:** about 1.5 days. **Prereqs:** E0.2 and E0.5.

## Current state
- `src/review/diff.ts:23` uses `-U0` and parses hunks with a regex.
- `src/review/context.ts:16-27` pastes the raw hunks into the prompt.
- The repo has no AST library.

## Goal
1. **Fragments.** Map every changed line range to its enclosing syntactic unit: function, method, class, or the top-level statement. The LLM then gets whole, parseable units with symbol names instead of context-free `-U0` hunks.
2. **Checks.** Run deterministic structural rules on those fragments and emit a `Finding[]`, limited to changed lines.

Library choice: **`@ast-grep/napi`** covers both parsing and rule matching, so we need one dependency instead of tree-sitter plus a separate rule engine. TS, TSX, JS, HTML and CSS are built in. Python is added through `@ast-grep/lang-python` with `registerDynamicLanguage`. **Verify the current API in the ast-grep docs (Context7 `/ast-grep/ast-grep`) before coding.** The snippets below are sketches.

---

## E2.1 Parser wrapper [x]
**File:** `src/review/ast/parse.ts`
```ts
import { parse, Lang, registerDynamicLanguage } from '@ast-grep/napi'
import python from '@ast-grep/lang-python'

let registered = false
const ensureLangs = () => { if (!registered) { registerDynamicLanguage({ python }); registered = true } }

export type AstLang = 'python' | 'typescript' | 'tsx' | 'javascript'
export const langFor = (file: string): AstLang | undefined => /* by extension: .py .ts .tsx .js .jsx .mjs .cjs */
export const parseFile = (lang: AstLang, source: string) => { ensureLangs(); return parse(lang === 'python' ? 'python' : Lang[...], source).root() }
```
- Files that fail to parse return `undefined` and log a warning. A parse failure must never fail the review.
- **Accept:** a unit test parses one fixture per language and checks the root node kind.

## E2.2 Fragment extraction [x]
**File:** `src/review/ast/fragments.ts`
```ts
export interface CodeFragment {
  file: string; lang: AstLang
  symbol: string            // "UserService.save", "<module>"
  kind: string              // function_definition | method_definition | class_declaration | ...
  startLine: number; endLine: number   // 1-based, full node span
  changedLines: LineRange[] // the intersection with the diff
  code: string              // node.text(), capped at 300 lines with "…truncated"
}
export const extractFragments = (file: ReviewFileWithDiff, lang: AstLang): CodeFragment[]
```
Algorithm:
1. For each changed range, find the smallest node covering `range.start`. Walk `.parent()` up until the node kind is in the language's `UNIT_KINDS`:
   - Python: `function_definition`, `class_definition`, `decorated_definition`.
   - TS/JS: `function_declaration`, `method_definition`, `arrow_function` assigned to a `variable_declarator`, `class_declaration`, `lexical_declaration` at top level.
   If no unit is found, fall back to the top-level statement.
2. Merge ranges that resolve to the same node.
3. Build the symbol name by walking enclosing class and function names.
4. Pure deletions (`isPureDeletion`) produce no fragment. Keep them as a short hunk note.

- **Tests:**
  - A change inside a method returns the whole method and the symbol `Class.method`.
  - Two changes in the same function produce one fragment.
  - A top-level change returns the statement.
  - A huge function gets truncated.
- **Accept:** tests pass on the E0.5 fixtures.

## E2.3 Rule packs [x]
**Files:** `src/review/ast/rules/python.yml`, `src/review/ast/rules/typescript.yml`, `src/review/ast/rules/index.ts`

Use ast-grep YAML rules. Each rule has `id`, `language`, `severity`, `message`, `rule`, plus a `metadata: { cwe }`. Minimum set:

| id | lang | pattern (sketch) | CWE |
|---|---|---|---|
| `py-eval-exec` | py | `eval($X)` / `exec($X)` where `$X` is not a string literal | CWE-95 |
| `py-subprocess-shell` | py | `subprocess.$F($$$, shell=True, $$$)` | CWE-78 |
| `py-os-system` | py | `os.system($X)` | CWE-78 |
| `py-sql-concat` | py | `$C.execute($A + $B)` / f-string / `%` formatting | CWE-89 |
| `py-pickle-loads` | py | `pickle.loads($X)` | CWE-502 |
| `py-yaml-unsafe` | py | `yaml.load($X)` without `Loader=SafeLoader` | CWE-502 |
| `py-requests-noverify` | py | `requests.$M($$$, verify=False, $$$)` | CWE-295 |
| `ts-eval` | ts | `eval($X)`, `new Function($$$)` | CWE-95 |
| `ts-child-exec-template` | ts | `exec(\`$$$${$X}$$$\`)`, `execSync` with template or concatenation | CWE-78 |
| `ts-sql-template` | ts | `$DB.query(\`$$$${$X}$$$\`)` | CWE-89 |
| `ts-innerhtml` | ts | `$E.innerHTML = $X` (non-literal) | CWE-79 |
| `ts-hardcoded-secret` | ts | `const $K = "$V"` where `$K` matches `/(secret|token|password|api_?key)/i` | CWE-798 |

- Load the rules with `findAll` per rule using the napi config object (or `ast-grep scan --json` if napi lacks YAML loading). Pick whichever the current docs support; that is a Deviation to record.
- **Accept:** each rule has one positive and one negative test snippet in `tests/review/ast/rules.test.ts`.

## E2.4 `runAstChecks` [x]
**File:** `src/review/ast/checks.ts`
```ts
export const runAstChecks = (files: ReviewFileWithDiff[]): Finding[]
```
- Parse each supported file once, run the rules for its language, and map the results to `Finding` with `source:'ast-grep'`, `status:'candidate'` and `symbol` taken from E2.2.
- Filter with `onlyChanged` from E0.2.
- Wrap it in a per-file time budget of 2s. ast-grep is in-process and fast, but this guards against pathological files.
- **Accept:** on the E0.5 fixtures it finds `py-subprocess-shell`, `py-sql-concat`, `py-eval-exec`, `ts-child-exec-template` and `ts-eval`, with zero findings in the clean files.

## E2.5 Prompt uses fragments [x]
**File:** `src/review/context.ts`
- Change `buildReviewPrompt(files, workspace)` to `buildReviewPrompt({files, fragments, findings}, workspace)`.
- Per file, emit each fragment as `### path › symbol (L12–L48, changed: 20–24)` followed by a fenced code block. Add the raw hunk only for pure deletions.
- Add a section `## Pre-detected findings (verify each)`. It is filled by E3 and E2.4 and capped at 50, highest severity first.
- Keep the old behaviour when `astChecks=false`, and for unsupported languages (fall back to hunks).
- Update `tests/review/context.test.ts` and its snapshots.
- **Accept:** the snapshot shows fragments for `.py` and `.ts` and hunks for `.md`.

## Pitfalls
- Line numbers: ast-grep ranges are 0-based, while diff and GitHub lines are 1-based. Write the conversion once, in `parse.ts`.
- Don't add every tree-sitter grammar. Python plus TS/JS covers the claim, and other languages fall back gracefully.
- `@ast-grep/napi` ships prebuilt native binaries. Check that `npm run build` (flue bundling) marks it **external**, and if it doesn't, add it to the externals in `flue.config.ts` (verify the option name in the flue docs).

## Done when
E2.1–E2.5 are ticked and `npm test` is green. Also run `flue run review` on the fixture repo and confirm the prompt it logs contains fragments.

## Deviations
1. **In-process ast-grep rule execution without runtime YAML dependency:** `@ast-grep/napi`'s Napi API exposes `root.findAll({ rule: NapiConfig['rule'] })` directly for parsed AST queries but does not bundle a YAML parser at runtime. Adding an external YAML parser (`js-yaml`) is not permitted by user-approved dependencies. The canonical rules were authored in standard ast-grep YAML files (`src/review/ast/rules/python.yml`, `src/review/ast/rules/typescript.yml`) for CLI tooling compatibility, and mirrored as typed `NapiConfig` definitions in `src/review/ast/rules/index.ts` for fast, zero-dependency in-process execution.
2. **Relational Search `stopBy: "end"`:** ast-grep napi's `has` relational matcher searches immediate children by default unless `stopBy: "end"` is specified. Configured `stopBy: "end"` on relational rules (e.g., keyword arguments `shell=True` and string interpolations inside function calls).
3. **Flue Bundling Native External:** Verified that `@ast-grep/napi` and `@ast-grep/lang-python` are natively externalized by flue's esbuild bundler into `dist/server.mjs` without requiring manual esbuild config overrides.

## Verification

### Automated tests
- `tests/review/ast/parse.test.ts`: 11/11 tests pass verifying parser wrapper, language detection (`.py`, `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`), line conversions (0-based to 1-based), and graceful degradation to `undefined` without throwing on syntax errors.
- `tests/review/ast/fragments.test.ts`: 9/9 tests pass verifying method extraction (`Class.method`), deduplication of multiple edits inside the same function into a single fragment, top-level statements, 300-line code truncation with `…truncated`, pure deletions, and extraction against `tests/fixtures/vuln-repo`.
- `tests/review/ast/rules.test.ts`: 14/14 tests pass with dedicated positive and negative test cases for all 12 security rules across Python and TypeScript.
- `tests/review/ast/checks.test.ts`: 4/4 tests pass verifying `runAstChecks` against `tests/fixtures/vuln-repo` detecting `py-subprocess-shell`, `py-sql-concat`, `py-eval-exec`, `ts-child-exec-template`, `ts-eval`, producing 0 findings on clean files, enforcing the 2s per-file timeout guard, and restricting findings to `onlyChanged` lines.
- `tests/review/context.test.ts`: 8/8 tests pass (including Vitest snapshot) verifying `buildReviewPrompt` formatting AST fragments for `.py` and `.ts`, falling back to diff hunks for `.md` and when `astChecks: false`, and rendering `## Pre-detected findings (verify each)` sorted by severity and capped at 50.
- All 200 tests passing in the full test suite.
- Quality gates pass: `npm run check && npm run check:types && npm test && npm run build` (built `dist/server.mjs` with 0 warnings/errors).

