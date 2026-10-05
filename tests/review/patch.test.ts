import { execSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Finding } from '../../src/review/findings'
import {
  buildPatch,
  buildPatches,
  writePatchFiles,
  applyPatch,
  applyApproved,
  PatchError,
  trimTrailingDuplicates,
} from '../../src/review/patch'

describe('E5.1 buildPatch', () => {
  let tmpRepo: string

  beforeEach(async () => {
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-test-repo-'))
    execSync('git init', { cwd: tmpRepo })
    execSync('git config user.name "Test User"', { cwd: tmpRepo })
    execSync('git config user.email "test@example.com"', { cwd: tmpRepo })
  })

  afterEach(async () => {
    await fs.rm(tmpRepo, { recursive: true, force: true }).catch(() => {})
  })

  it('generates a clean unified diff for a single-line fix and applies with git apply', async () => {
    const filePath = 'src/example.ts'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(
      fullPath,
      'export function hello() {\n  const msg = "foo"\n  return msg\n}\n',
      'utf8'
    )
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const finding: Finding = {
      id: 'find1',
      source: 'llm',
      ruleId: 'no-foo',
      severity: 'medium',
      file: filePath,
      startLine: 2,
      endLine: 2,
      message: 'Prefer bar over foo',
      status: 'confirmed',
      fix: {
        replacement: '  const msg = "bar"',
        startLine: 2,
        endLine: 2,
      },
    }

    const patch = await buildPatch(tmpRepo, finding)

    expect(patch.id).toMatch(/^[0-9a-f]{8}$/)
    expect(patch.file).toBe(filePath)
    expect(patch.stats).toEqual({ added: 1, removed: 1 })
    expect(patch.diff).toContain(`diff --git a/${filePath} b/${filePath}`)
    expect(patch.diff).toContain(`--- a/${filePath}`)
    expect(patch.diff).toContain(`+++ b/${filePath}`)
    expect(patch.diff).toContain('-  const msg = "foo"')
    expect(patch.diff).toContain('+  const msg = "bar"')

    // Verify it applies cleanly
    await applyPatch(tmpRepo, patch)
    const content = await fs.readFile(fullPath, 'utf8')
    expect(content).toBe(
      'export function hello() {\n  const msg = "bar"\n  return msg\n}\n'
    )
  })

  it('generates unified diff for multi-line replacement and applies cleanly', async () => {
    const filePath = 'index.js'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.writeFile(
      fullPath,
      'function compute() {\n  const a = 1\n  const b = 2\n  return a + b\n}\n',
      'utf8'
    )
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const finding: Finding = {
      id: 'find2',
      source: 'llm',
      ruleId: 'refactor',
      severity: 'low',
      file: filePath,
      startLine: 2,
      endLine: 3,
      message: 'Combine constants',
      status: 'confirmed',
      fix: {
        replacement: '  const [a, b] = [10, 20]\n  console.log("summing")',
        startLine: 2,
        endLine: 3,
      },
    }

    const patch = await buildPatch(tmpRepo, finding)

    expect(patch.stats).toEqual({ added: 2, removed: 2 })
    expect(patch.diff).toContain('+  const [a, b] = [10, 20]')
    expect(patch.diff).toContain('+  console.log("summing")')
    expect(patch.diff).toContain('-  const a = 1')
    expect(patch.diff).toContain('-  const b = 2')

    await applyPatch(tmpRepo, patch)
    const updated = await fs.readFile(fullPath, 'utf8')
    expect(updated).toBe(
      'function compute() {\n  const [a, b] = [10, 20]\n  console.log("summing")\n  return a + b\n}\n'
    )
  })

  it('preserves CRLF line endings when file uses Windows line breaks', async () => {
    const filePath = 'windows.txt'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.writeFile(fullPath, 'line 1\r\nline 2\r\nline 3\r\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const finding: Finding = {
      id: 'crlf-finding',
      source: 'llm',
      ruleId: 'rule',
      severity: 'medium',
      file: filePath,
      startLine: 2,
      endLine: 2,
      message: 'replace line 2',
      status: 'confirmed',
      fix: {
        replacement: 'replaced line 2',
        startLine: 2,
        endLine: 2,
      },
    }

    const patch = await buildPatch(tmpRepo, finding)
    await applyPatch(tmpRepo, patch)

    const updated = await fs.readFile(fullPath, 'utf8')
    expect(updated).toBe('line 1\r\nreplaced line 2\r\nline 3\r\n')
    expect(updated.includes('\r\n')).toBe(true)
  })

  it('fails when the target file was modified (stale fix fails git apply --check)', async () => {
    const filePath = 'stale.txt'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.writeFile(fullPath, 'original line 1\noriginal line 2\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const finding: Finding = {
      id: 'stale-finding',
      source: 'llm',
      ruleId: 'stale',
      severity: 'high',
      file: filePath,
      startLine: 1,
      endLine: 1,
      message: 'update line 1',
      status: 'confirmed',
      fix: {
        replacement: 'new line 1',
        startLine: 1,
        endLine: 1,
      },
    }

    // Build the patch for original file
    const patch = await buildPatch(tmpRepo, finding)

    // Now modify the file on disk so the patch becomes stale
    await fs.writeFile(
      fullPath,
      'completely changed line A\ncompletely changed line B\n',
      'utf8'
    )

    // Applying stale patch fails git apply --check
    await expect(applyPatch(tmpRepo, patch)).rejects.toThrow(/apply --check/)
  })

  it('rejects out-of-range edits exceeding finding range +/- 3 lines of context', async () => {
    const filePath = 'range.txt'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.writeFile(
      fullPath,
      Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
      'utf8'
    )
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const finding: Finding = {
      id: 'range-finding',
      source: 'llm',
      ruleId: 'range',
      severity: 'medium',
      file: filePath,
      startLine: 10,
      endLine: 10,
      message: 'test range',
      status: 'confirmed',
      fix: {
        // Line 5 is outside [10-3, 10+3] = [7, 13]
        replacement: 'bad edit',
        startLine: 5,
        endLine: 5,
      },
    }

    await expect(buildPatch(tmpRepo, finding)).rejects.toThrow(/exceeds allowed range/)
  })

  it('rejects patches that change more than 60 lines', async () => {
    const filePath = 'large.txt'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.writeFile(
      fullPath,
      Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
      'utf8'
    )
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const finding: Finding = {
      id: 'large-finding',
      source: 'llm',
      ruleId: 'large',
      severity: 'medium',
      file: filePath,
      startLine: 10,
      endLine: 20,
      message: 'large edit',
      status: 'confirmed',
      fix: {
        replacement: Array.from({ length: 65 }, (_, i) => `new line ${i}`).join('\n'),
        startLine: 10,
        endLine: 15,
      },
    }

    await expect(buildPatch(tmpRepo, finding)).rejects.toThrow(/maximum allowed is 60/)
  })

  it('rejects path traversal attempts', async () => {
    const finding: Finding = {
      id: 'traversal-finding',
      source: 'llm',
      ruleId: 'sec',
      severity: 'critical',
      file: '../secret.txt',
      startLine: 1,
      endLine: 1,
      message: 'exploit',
      status: 'confirmed',
      fix: {
        replacement: 'exploit',
        startLine: 1,
        endLine: 1,
      },
    }

    await expect(buildPatch(tmpRepo, finding)).rejects.toThrow(PatchError)
  })

  it('buildPatches builds patches only for confirmed findings with fixes', async () => {
    const file = 'hello.ts'
    await fs.writeFile(path.join(tmpRepo, file), 'export const a = 1\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const findings: Finding[] = [
      {
        id: 'confirmed-with-fix',
        source: 'llm',
        ruleId: 'r1',
        severity: 'medium',
        file,
        startLine: 1,
        endLine: 1,
        message: 'fix a',
        status: 'confirmed',
        fix: { replacement: 'export const a = 2', startLine: 1, endLine: 1 },
      },
      {
        id: 'dismissed-with-fix',
        source: 'llm',
        ruleId: 'r2',
        severity: 'low',
        file,
        startLine: 1,
        endLine: 1,
        message: 'dismissed',
        status: 'dismissed',
        fix: { replacement: 'export const a = 3', startLine: 1, endLine: 1 },
      },
      {
        id: 'confirmed-without-fix',
        source: 'llm',
        ruleId: 'r3',
        severity: 'high',
        file,
        startLine: 1,
        endLine: 1,
        message: 'no fix',
        status: 'confirmed',
      },
    ]

    const patches = await buildPatches(tmpRepo, findings)
    expect(patches).toHaveLength(1)
    expect(patches[0].findingId).toBe('confirmed-with-fix')
  })

  it('writePatchFiles writes .patch files to .CodeSentinel/patches/<id>.patch', async () => {
    const patches = [
      {
        id: '1234abcd',
        findingId: 'f1',
        file: 'test.ts',
        diff: 'diff --git a/test.ts b/test.ts\n',
        stats: { added: 1, removed: 0 },
      },
    ]

    const paths = await writePatchFiles(tmpRepo, patches)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe(
      path.join(tmpRepo, '.CodeSentinel', 'patches', '1234abcd.patch')
    )

    const written = await fs.readFile(paths[0], 'utf8')
    expect(written).toBe('diff --git a/test.ts b/test.ts\n')
  })

  it('applyApproved applies approved patches and skips rejected patches', async () => {
    const file1 = 'file1.txt'
    const file2 = 'file2.txt'
    await fs.writeFile(path.join(tmpRepo, file1), 'original 1\n', 'utf8')
    await fs.writeFile(path.join(tmpRepo, file2), 'original 2\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const finding1: Finding = {
      id: 'f1',
      source: 'llm',
      ruleId: 'r1',
      severity: 'medium',
      file: file1,
      startLine: 1,
      endLine: 1,
      message: 'm1',
      status: 'confirmed',
      fix: { replacement: 'approved 1', startLine: 1, endLine: 1 },
    }
    const finding2: Finding = {
      id: 'f2',
      source: 'llm',
      ruleId: 'r2',
      severity: 'medium',
      file: file2,
      startLine: 1,
      endLine: 1,
      message: 'm2',
      status: 'confirmed',
      fix: { replacement: 'rejected 2', startLine: 1, endLine: 1 },
    }

    const patch1 = await buildPatch(tmpRepo, finding1)
    const patch2 = await buildPatch(tmpRepo, finding2)

    const applied = await applyApproved(tmpRepo, [patch1, patch2], {
      [patch1.id]: 'approve',
      [patch2.id]: 'reject',
    })

    expect(applied).toEqual([patch1.id])
    const c1 = await fs.readFile(path.join(tmpRepo, file1), 'utf8')
    const c2 = await fs.readFile(path.join(tmpRepo, file2), 'utf8')
    expect(c1).toBe('approved 1\n')
    expect(c2).toBe('original 2\n')
  })

  it('rejects patch with invalid_syntax if replacement introduces TypeScript syntax errors', async () => {
    const filePath = 'src/broken.ts'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, 'const validNumber = 42\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const finding: Finding = {
      id: 'f-bad-syntax',
      source: 'llm',
      ruleId: 'r-ts',
      severity: 'high',
      file: filePath,
      startLine: 1,
      endLine: 1,
      message: 'broken syntax',
      status: 'confirmed',
      fix: {
        replacement: 'const validNumber: number = ;',
        startLine: 1,
        endLine: 1,
      },
    }

    await expect(buildPatch(tmpRepo, finding)).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof PatchError &&
        err.kind === 'invalid_syntax' &&
        err.message.includes('syntax errors')
      )
    })
  })

  it('handles auth_logic case: expands to enclosing statement to produce valid python that compiles', async () => {
    const filePath = 'app/auth_logic.py'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    const originalContent =
      'def authorize_action(user, action):\n    if not user.is_admin:\n        return True\n    return action in user.permissions\n'
    await fs.writeFile(fullPath, originalContent, 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    // Finding targets line 2 only, but statement expansion expands to 2..3 so line 3 orphan indent is not left
    const finding: Finding = {
      id: 'f-auth',
      source: 'llm',
      ruleId: 'r-auth',
      severity: 'critical',
      file: filePath,
      startLine: 2,
      endLine: 2,
      message: 'Remove admin bypass',
      status: 'confirmed',
      fix: {
        replacement: '    return action in user.permissions',
        startLine: 2,
        endLine: 2,
      },
    }

    const patch = await buildPatch(tmpRepo, finding)
    expect(patch.file).toBe(filePath)
    await applyPatch(tmpRepo, patch)

    const updated = await fs.readFile(fullPath, 'utf8')
    expect(updated).not.toContain('        return True')

    // Verify it compiles cleanly with python3 -m py_compile
    expect(() => {
      execSync(`python3 -m py_compile "${fullPath}"`)
    }).not.toThrow()
  })

  it('rejects patch when invalid python syntax cannot be repaired by statement expansion', async () => {
    const filePath = 'app/invalid.py'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, 'def compute():\n    return 42\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const finding: Finding = {
      id: 'f-bad-py',
      source: 'llm',
      ruleId: 'r-py',
      severity: 'high',
      file: filePath,
      startLine: 2,
      endLine: 2,
      message: 'broken py',
      status: 'confirmed',
      fix: {
        replacement: '    return (42 +',
        startLine: 2,
        endLine: 2,
      },
    }

    await expect(buildPatch(tmpRepo, finding)).rejects.toSatisfy((err: unknown) => {
      return err instanceof PatchError && err.kind === 'invalid_syntax'
    })
  })

  it('trimTrailingDuplicates trims overlapping trailing lines', () => {
    const repl = ['line1', 'line2', 'line3']
    const follow = ['line3', 'line4']
    expect(trimTrailingDuplicates(repl, follow)).toEqual(['line1', 'line2'])

    const replMulti = ['a', 'b', 'c', 'd']
    const followMulti = ['c', 'd', 'e']
    expect(trimTrailingDuplicates(replMulti, followMulti)).toEqual(['a', 'b'])

    const replNoMatch = ['a', 'b']
    const followNoMatch = ['x', 'y']
    expect(trimTrailingDuplicates(replNoMatch, followNoMatch)).toEqual(['a', 'b'])
  })

  it('trims trailing duplicate lines in replacement matching following file lines (auth_logic case)', async () => {
    const filePath = 'app/auth_logic.py'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    const originalContent =
      'def authorize_action(user, action):\n' +
      '    if not user.is_admin:\n' +
      '        return True\n' +
      '    return action in user.permissions\n'
    await fs.writeFile(fullPath, originalContent, 'utf8')
    execSync('git add . && git commit -m "initial auth_logic"', { cwd: tmpRepo })

    // LLM suggests fix for L2-3 but includes the unchanged L4
    const finding: Finding = {
      id: 'f-auth-dup',
      source: 'llm',
      ruleId: 'CWE-862',
      severity: 'critical',
      file: filePath,
      startLine: 2,
      endLine: 3,
      message: 'Reverse authorization guard',
      status: 'confirmed',
      fix: {
        replacement:
          '    if user.is_admin:\n' +
          '        return True\n' +
          '    return action in user.permissions',
        startLine: 2,
        endLine: 3,
      },
    }

    const patch = await buildPatch(tmpRepo, finding)
    expect(patch.file).toBe(filePath)

    // Apply the patch
    await applyPatch(tmpRepo, patch)

    const updated = await fs.readFile(fullPath, 'utf8')
    // Must NOT have duplicate "return action in user.permissions"
    const occurrences = updated.split('return action in user.permissions').length - 1
    expect(occurrences).toBe(1)
    expect(updated).toBe(
      'def authorize_action(user, action):\n' +
        '    if user.is_admin:\n' +
        '        return True\n' +
        '    return action in user.permissions\n'
    )

    // Verify it compiles cleanly with python3
    expect(() => {
      execSync(`python3 -m py_compile "${fullPath}"`)
    }).not.toThrow()
  })
})
