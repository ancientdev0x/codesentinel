import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractFragments, truncateCode } from '../../../src/review/ast/fragments'
import type { ReviewFileWithDiff } from '../../../src/review/diff'

const makeFile = (
  fileName: string,
  fileContent: string,
  changedLines: { start: number; end: number }[],
  isPureDeletion = false
): ReviewFileWithDiff => ({
  fileName,
  fileContent,
  changedLines,
  diff: 'dummy diff',
  isPureDeletion,
})

describe('AST fragment extraction (fragments.ts)', () => {
  it('returns empty fragments for pure deletions', () => {
    const file = makeFile(
      'src/delete.ts',
      'export const a = 1\n',
      [{ start: 1, end: 1 }],
      true
    )
    const frags = extractFragments(file, 'typescript')
    expect(frags).toEqual([])
  })

  it('returns empty fragments when fileContent is empty', () => {
    const file = makeFile('src/empty.ts', '', [{ start: 1, end: 1 }])
    const frags = extractFragments(file, 'typescript')
    expect(frags).toEqual([])
  })

  it('returns method fragment with Class.method symbol for a method change', () => {
    const code = [
      'class UserService {',
      '  save(user: any) {',
      '    const sanitized = sanitize(user)',
      '    return db.save(sanitized)',
      '  }',
      '}',
    ].join('\n')

    // Change on line 3 (the sanitize line)
    const file = makeFile('src/user.ts', code, [{ start: 3, end: 3 }])
    const frags = extractFragments(file, 'typescript')

    expect(frags).toHaveLength(1)
    expect(frags[0].symbol).toBe('UserService.save')
    expect(frags[0].kind).toBe('method_definition')
    expect(frags[0].startLine).toBe(2)
    expect(frags[0].endLine).toBe(5)
    expect(frags[0].code).toContain('save(user: any)')
    expect(frags[0].changedLines).toEqual([{ start: 3, end: 3 }])
  })

  it('merges two changes in the same function into one fragment', () => {
    const code = [
      'function processItems(items: string[]) {',
      '  const step1 = items.filter(Boolean)',
      '  console.log("processing")',
      '  const step2 = step1.map(x => x.trim())',
      '  return step2',
      '}',
    ].join('\n')

    // Changes on line 2 and line 4 in the same function
    const file = makeFile('src/process.ts', code, [
      { start: 2, end: 2 },
      { start: 4, end: 4 },
    ])
    const frags = extractFragments(file, 'typescript')

    expect(frags).toHaveLength(1)
    expect(frags[0].symbol).toBe('processItems')
    expect(frags[0].kind).toBe('function_declaration')
    expect(frags[0].startLine).toBe(1)
    expect(frags[0].endLine).toBe(6)
    expect(frags[0].changedLines).toEqual([
      { start: 2, end: 2 },
      { start: 4, end: 4 },
    ])
  })

  it('returns top-level statement with <module> symbol for top-level changes', () => {
    const code = [
      'import { config } from "dotenv"',
      'config()',
      'export const PORT = 3000',
    ].join('\n')

    // Change on line 2 (config() call)
    const file = makeFile('src/server.ts', code, [{ start: 2, end: 2 }])
    const frags = extractFragments(file, 'typescript')

    expect(frags).toHaveLength(1)
    expect(frags[0].symbol).toBe('<module>')
    expect(frags[0].startLine).toBe(2)
    expect(frags[0].endLine).toBe(2)
    expect(frags[0].code).toBe('config()')
  })

  it('truncates functions exceeding 300 lines with …truncated', () => {
    const lines = ['function bigFunction() {']
    for (let i = 0; i < 350; i++) {
      lines.push(`  const x_${i} = ${i}`)
    }
    lines.push('  return 0\n}')
    const code = lines.join('\n')

    const file = makeFile('src/big.ts', code, [{ start: 10, end: 10 }])
    const frags = extractFragments(file, 'typescript')

    expect(frags).toHaveLength(1)
    expect(frags[0].code).toContain('…truncated')
    expect(frags[0].code.split('\n')).toHaveLength(301)
  })

  it('truncateCode helper truncates when line count exceeds max', () => {
    const shortCode = 'line 1\nline 2'
    expect(truncateCode(shortCode, 5)).toBe(shortCode)

    const longCode = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    const truncated = truncateCode(longCode, 3)
    expect(truncated).toBe('line 1\nline 2\nline 3\n…truncated')
  })

  it('extracts Python fragments from vuln-repo fixtures', async () => {
    const fixturePath = join(__dirname, '../../fixtures/vuln-repo/head/app/calc.py')
    const content = await readFile(fixturePath, 'utf8')
    const file = makeFile(fixturePath, content, [{ start: 2, end: 2 }])
    const frags = extractFragments(file, 'python')

    expect(frags.length).toBeGreaterThanOrEqual(1)
    expect(frags[0].symbol).toBe('evaluate')
    expect(frags[0].kind).toBe('function_definition')
    expect(frags[0].code).toContain('def evaluate')
  })

  it('extracts TypeScript fragments from vuln-repo fixtures', async () => {
    const fixturePath = join(__dirname, '../../fixtures/vuln-repo/head/web/exec.ts')
    const content = await readFile(fixturePath, 'utf8')
    const file = makeFile(fixturePath, content, [{ start: 6, end: 7 }])
    const frags = extractFragments(file, 'typescript')

    expect(frags.length).toBeGreaterThanOrEqual(1)
    expect(frags[0].symbol).toBe('listDir')
    expect(frags[0].kind).toBe('function_declaration')
    expect(frags[0].code).toContain('function listDir')
  })
})
