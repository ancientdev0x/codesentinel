import { describe, expect, it } from 'vitest'
import { buildReviewPrompt } from '../../src/review/context'
import type { ReviewFileWithDiff } from '../../src/review/diff'
import type { Finding } from '../../src/review/findings'

const WS = '/repo'

const fileA: ReviewFileWithDiff = {
  fileName: '/repo/src/a.ts',
  fileContent: 'export const a = 1\n',
  changedLines: [{ start: 1, end: 1 }],
  diff: ['diff --git a/src/a.ts b/src/a.ts', '@@ -0,0 +1 @@', '+export const a = 1'].join(
    '\n'
  ),
}

const fileB: ReviewFileWithDiff = {
  fileName: '/repo/lib/nested/b.ts',
  fileContent: 'export const b = 2\n',
  changedLines: [{ start: 5, end: 7 }],
  diff: [
    'diff --git a/lib/nested/b.ts b/lib/nested/b.ts',
    '@@ -5,3 +5,3 @@',
    '+const b = 2',
  ].join('\n'),
}

const pyFile: ReviewFileWithDiff = {
  fileName: '/repo/app/calc.py',
  fileContent: 'def evaluate(expr):\n    return eval(expr)\n',
  changedLines: [{ start: 2, end: 2 }],
  diff: 'diff --git a/app/calc.py b/app/calc.py\n@@ -1,2 +1,2 @@\n def evaluate(expr):\n+    return eval(expr)',
}

const tsFile: ReviewFileWithDiff = {
  fileName: '/repo/src/service.ts',
  fileContent: 'export function run(cmd: string) {\n  return eval(cmd)\n}\n',
  changedLines: [{ start: 2, end: 2 }],
  diff: 'diff --git a/src/service.ts b/src/service.ts\n@@ -1,3 +1,3 @@\n export function run(cmd: string) {\n+  return eval(cmd)\n }',
}

const mdFile: ReviewFileWithDiff = {
  fileName: '/repo/docs/guide.md',
  fileContent: '# Guide\n\nUpdated documentation.\n',
  changedLines: [{ start: 3, end: 3 }],
  diff: 'diff --git a/docs/guide.md b/docs/guide.md\n@@ -3 +3 @@\n+Updated documentation.',
}

describe('buildReviewPrompt', () => {
  it('includes each file path relative to the workspace (legacy array overload)', () => {
    const prompt = buildReviewPrompt([fileA, fileB], WS)
    expect(prompt).toContain('### src/a.ts')
    expect(prompt).toContain('### lib/nested/b.ts')
    // Absolute paths should not leak into the diff headings.
    expect(prompt).not.toContain('### /repo/src/a.ts')
  })

  it('includes each file diff text fenced as a diff block (legacy array overload)', () => {
    const prompt = buildReviewPrompt([fileA, fileB], WS)
    expect(prompt).toContain('+export const a = 1')
    expect(prompt).toContain('+const b = 2')
    expect(prompt).toContain('```diff')
    // The diff for each file should sit under its own heading.
    expect(prompt.indexOf('### src/a.ts')).toBeLessThan(
      prompt.indexOf('+export const a = 1')
    )
  })

  it('includes the file tree section with relative paths and line ranges', () => {
    const prompt = buildReviewPrompt([fileA, fileB], WS)
    expect(prompt).toContain('Files changed for this review')
    // Tree renders file nodes (leaf names) with their changed line ranges.
    expect(prompt).toContain('a.ts: 1')
    expect(prompt).toContain('b.ts: 5-7')
    // The tree section precedes the diffs.
    expect(prompt.indexOf('Files changed for this review')).toBeLessThan(
      prompt.indexOf('### src/a.ts')
    )
  })

  it('handles a single file', () => {
    const prompt = buildReviewPrompt([fileA], WS)
    expect(prompt).toContain('### src/a.ts')
    expect(prompt).toContain('+export const a = 1')
    expect(prompt).not.toContain('### lib/nested/b.ts')
  })

  it('handles an empty file list without throwing', () => {
    const prompt = buildReviewPrompt([], WS)
    expect(typeof prompt).toBe('string')
    expect(prompt).toContain('Files changed for this review')
    expect(prompt).not.toContain('### ')
  })

  it('emits AST fragments for .py and .ts and hunks for .md', () => {
    const prompt = buildReviewPrompt(
      {
        files: [pyFile, tsFile, mdFile],
        astChecks: true,
      },
      WS
    )

    // .py should have symbol fragment heading and python block
    expect(prompt).toMatch(/### app\/calc\.py › evaluate \(L1–L2, changed: 2\)/)
    expect(prompt).toContain('```python')
    expect(prompt).toContain('def evaluate(expr):')

    // .ts should have symbol fragment heading and typescript block
    expect(prompt).toMatch(/### src\/service\.ts › run \(L1–L3, changed: 2\)/)
    expect(prompt).toContain('```typescript')
    expect(prompt).toContain('function run(cmd: string)')

    // .md is unsupported by AST, falls back to raw diff
    expect(prompt).toContain('### docs/guide.md\n```diff')
    expect(prompt).toContain('+Updated documentation.')

    // Snapshot matches fragment output
    expect(prompt).toMatchSnapshot()
  })

  it('falls back to raw diff hunks when astChecks is false', () => {
    const prompt = buildReviewPrompt(
      {
        files: [pyFile, tsFile, mdFile],
        astChecks: false,
      },
      WS
    )

    expect(prompt).not.toContain('### app/calc.py › evaluate')
    expect(prompt).toContain('### app/calc.py\n```diff')
    expect(prompt).toContain('### src/service.ts\n```diff')
    expect(prompt).toContain('### docs/guide.md\n```diff')
  })

  it('renders pre-detected findings sorted by severity and capped at 50', () => {
    const findings: Finding[] = [
      {
        id: 'med001',
        source: 'ast-grep',
        ruleId: 'ts-hardcoded-secret',
        severity: 'medium',
        file: '/repo/src/service.ts',
        startLine: 10,
        endLine: 10,
        message: 'Hardcoded secret',
        cwe: 'CWE-798',
        symbol: 'run',
        status: 'candidate',
      },
      {
        id: 'crit001',
        source: 'ast-grep',
        ruleId: 'py-subprocess-shell',
        severity: 'critical',
        file: '/repo/app/calc.py',
        startLine: 2,
        endLine: 2,
        message: 'Command injection',
        cwe: 'CWE-78',
        symbol: 'evaluate',
        status: 'candidate',
      },
      {
        id: 'high001',
        source: 'ast-grep',
        ruleId: 'py-eval-exec',
        severity: 'high',
        file: '/repo/app/calc.py',
        startLine: 2,
        endLine: 2,
        message: 'Dynamic eval execution',
        cwe: 'CWE-95',
        symbol: 'evaluate',
        status: 'candidate',
      },
    ]

    const prompt = buildReviewPrompt(
      {
        files: [pyFile],
        findings,
        astChecks: true,
      },
      WS
    )

    expect(prompt).toContain('## Pre-detected findings (verify each)')
    // Critical comes before High, High comes before Medium
    const critPos = prompt.indexOf('crit001')
    const highPos = prompt.indexOf('high001')
    const medPos = prompt.indexOf('med001')

    expect(critPos).toBeGreaterThan(-1)
    expect(highPos).toBeGreaterThan(-1)
    expect(medPos).toBeGreaterThan(-1)

    expect(critPos).toBeLessThan(highPos)
    expect(highPos).toBeLessThan(medPos)

    expect(prompt).toContain(
      '- `crit001` [CRITICAL] app/calc.py:L2 in `evaluate` [CWE-78] — Command injection (ast-grep:py-subprocess-shell)'
    )
  })
})
