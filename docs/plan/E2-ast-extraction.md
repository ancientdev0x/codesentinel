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

## E2.1 Parser wrapper
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

## E2.2 Fragment extraction
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

## E2.3 Rule packs
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

## E2.4 `runAstChecks`
**File:** `src/review/ast/checks.ts`
```ts
export const runAstChecks = (files: ReviewFileWithDiff[]): Finding[]
```
- Parse each supported file once, run the rules for its language, and map the results to `Finding` with `source:'ast-grep'`, `status:'candidate'` and `symbol` taken from E2.2.
- Filter with `onlyChanged` from E0.2.
- Wrap it in a per-file time budget of 2s. ast-grep is in-process and fast, but this guards against pathological files.
- **Accept:** on the E0.5 fixtures it finds `py-subprocess-shell`, `py-sql-concat`, `py-eval-exec`, `ts-child-exec-template` and `ts-eval`, with zero findings in the clean files.

## E2.5 Prompt uses fragments
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
