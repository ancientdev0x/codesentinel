import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Finding } from './findings'
import type { SgNode } from '@ast-grep/napi'
import { langFor, nodeLineSpan, parseFile } from './ast/parse'

const execFileAsync = promisify(execFile)

export const runWithStdin = (
  cmd: string,
  args: string[],
  stdinText: string,
  cwd?: string
): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer | string) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer | string) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const err = new Error(
          `Command "${cmd} ${args.join(' ')}" exited with code ${code}: ${stderr.trim() || stdout.trim()}`
        )
        ;(err as { code?: number }).code = code ?? undefined
        reject(err)
      }
    })
    child.stdin.end(stdinText)
  })
}

export interface Patch {
  id: string
  findingId: string
  file: string
  diff: string
  stats: { added: number; removed: number }
}

export class PatchError extends Error {
  readonly kind: 'bad_patch' | 'invalid_syntax'

  constructor(message: string, kind: 'bad_patch' | 'invalid_syntax' = 'bad_patch') {
    super(message)
    this.name = 'PatchError'
    this.kind = kind
  }
}

const STATEMENT_KINDS = new Set([
  'if_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  'try_statement',
  'with_statement',
  'switch_statement',
  'expression_statement',
  'return_statement',
  'throw_statement',
  'break_statement',
  'continue_statement',
  'variable_statement',
  'lexical_declaration',
  'variable_declaration',
  'assignment',
  'augmented_assignment',
  'assert_statement',
  'raise_statement',
  'pass_statement',
])

export const findEnclosingStatementSpan = (
  root: SgNode | undefined,
  startLine: number,
  endLine: number
): { startLine: number; endLine: number } | undefined => {
  if (!root) return undefined
  let matched: { startLine: number; endLine: number } | undefined
  const walk = (node: SgNode) => {
    const span = nodeLineSpan(node)
    if (span.startLine <= startLine && span.endLine >= endLine) {
      const k = String(node.kind())
      if (
        STATEMENT_KINDS.has(k) ||
        k.endsWith('_statement') ||
        k.endsWith('_declaration')
      ) {
        matched = span
      }
      for (const child of node.children()) {
        walk(child)
      }
    }
  }
  walk(root)
  return matched
}

export const countAstErrors = (root: SgNode | undefined): number => {
  if (!root) return 0
  let count = 0
  const walk = (n: SgNode) => {
    const k = n.kind()
    if (k === 'ERROR' || k === 'MISSING') {
      count++
    }
    for (const child of n.children()) {
      walk(child)
    }
  }
  walk(root)
  return count
}

export const validateSyntax = async (
  file: string,
  rawContent: string,
  newContent: string
): Promise<void> => {
  const lang = langFor(file)
  if (!lang) return

  const origRoot = parseFile(lang, rawContent)
  const patchedRoot = parseFile(lang, newContent)

  const origErrors = countAstErrors(origRoot)
  const patchedErrors = countAstErrors(patchedRoot)

  if (patchedErrors > origErrors) {
    throw new PatchError(
      `Patched file "${file}" has syntax errors (${patchedErrors} error/missing AST nodes vs ${origErrors} in original)`,
      'invalid_syntax'
    )
  }

  if (lang === 'python') {
    try {
      await runWithStdin(
        'python3',
        ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'],
        newContent
      )
    } catch (pyErr: unknown) {
      let origHadError = false
      try {
        await runWithStdin(
          'python3',
          ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'],
          rawContent
        )
      } catch {
        origHadError = true
      }
      if (!origHadError) {
        const msg = pyErr instanceof Error ? pyErr.message : String(pyErr)
        throw new PatchError(
          `Patched file "${file}" has Python syntax/indentation error: ${msg.trim()}`,
          'invalid_syntax'
        )
      }
    }
  }
}

/**
 * Builds a verified unified diff Patch from a Finding fix.
 * Replaces lines fix.startLine..fix.endLine with fix.replacement,
 * generates a unified diff via `git diff --no-index`, rewrites headers,
 * and validates application with `git apply --check`.
 */
export const buildPatch = async (workspace: string, finding: Finding): Promise<Patch> => {
  const { fix } = finding
  if (!fix) {
    throw new PatchError(`Finding ${finding.id} has no fix attached`)
  }

  // Security checks: prevent directory traversal or absolute paths
  if (path.isAbsolute(finding.file) || finding.file.includes('..')) {
    throw new PatchError(`Invalid file path in finding: "${finding.file}"`)
  }

  const resolvedWorkspace = path.resolve(workspace)
  const resolvedTarget = path.resolve(resolvedWorkspace, finding.file)
  if (!resolvedTarget.startsWith(resolvedWorkspace)) {
    throw new PatchError(`Target file "${finding.file}" escapes workspace boundary`)
  }

  let rawContent: string
  try {
    rawContent = await fs.readFile(resolvedTarget, 'utf8')
  } catch (err: unknown) {
    throw new PatchError(
      `Cannot read target file "${finding.file}": ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // Preserve line endings and trailing newline
  const isCrlf = rawContent.includes('\r\n')
  const eol = isCrlf ? '\r\n' : '\n'
  const hasTrailingEol = rawContent.endsWith('\n')

  let text = rawContent
  if (text.endsWith('\r\n')) {
    text = text.slice(0, -2)
  } else if (text.endsWith('\n')) {
    text = text.slice(0, -1)
  }
  const lines = text.length === 0 ? [] : text.split(/\r?\n/)

  if (
    fix.startLine < 1 ||
    fix.endLine < fix.startLine ||
    fix.startLine > lines.length ||
    fix.endLine > lines.length
  ) {
    throw new PatchError(
      `Fix line range ${fix.startLine}..${fix.endLine} is out of bounds for file "${finding.file}" (${lines.length} lines)`
    )
  }

  // Reject fixes touching lines outside finding's range +/- 3 lines of context
  const minAllowed = Math.max(1, finding.startLine - 3)
  const maxAllowed = finding.endLine + 3
  if (fix.startLine < minAllowed || fix.endLine > maxAllowed) {
    throw new PatchError(
      `Fix line range ${fix.startLine}..${fix.endLine} exceeds allowed range ${minAllowed}..${maxAllowed} for finding range ${finding.startLine}..${finding.endLine}`
    )
  }

  const replacementLines =
    fix.replacement.length === 0 ? [] : fix.replacement.replace(/\r\n/g, '\n').split('\n')

  // Quick initial check on change volume
  const removedLinesCount = fix.endLine - fix.startLine + 1
  if (removedLinesCount + replacementLines.length > 60) {
    throw new PatchError(
      `Patch changes ${removedLinesCount + replacementLines.length} lines (maximum allowed is 60)`
    )
  }

  const constructContent = (start: number, end: number): string => {
    const beforeSection = lines.slice(0, start - 1)
    const afterSection = lines.slice(end)
    const newLines = [...beforeSection, ...replacementLines, ...afterSection]
    let content = newLines.join(eol)
    if (hasTrailingEol || (lines.length > 0 && newLines.length > 0)) {
      content += eol
    }
    return content
  }

  let newContent = constructContent(fix.startLine, fix.endLine)

  // Post-apply syntax validation with statement expansion fallback
  try {
    await validateSyntax(finding.file, rawContent, newContent)
  } catch (syntaxErr: unknown) {
    if (syntaxErr instanceof PatchError && syntaxErr.kind === 'invalid_syntax') {
      const lang = langFor(finding.file)
      const origRoot = lang ? parseFile(lang, rawContent) : undefined
      const encSpan = origRoot
        ? findEnclosingStatementSpan(origRoot, fix.startLine, fix.endLine)
        : undefined

      let recovered = false
      if (
        encSpan &&
        (encSpan.startLine < fix.startLine || encSpan.endLine > fix.endLine) &&
        encSpan.startLine >= minAllowed &&
        encSpan.endLine <= maxAllowed
      ) {
        const expandedContent = constructContent(encSpan.startLine, encSpan.endLine)
        try {
          await validateSyntax(finding.file, rawContent, expandedContent)
          newContent = expandedContent
          recovered = true
        } catch {
          // Statement expansion did not resolve syntax issue
        }
      }

      if (!recovered) {
        throw syntaxErr
      }
    } else {
      throw syntaxErr
    }
  }

  // Create temporary directory for git diff --no-index
  const repoPath = finding.file.replace(/\\/g, '/')
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesentinel-patch-'))

  try {
    const beforeFile = path.join(tmpDir, 'a', repoPath)
    const afterFile = path.join(tmpDir, 'b', repoPath)
    await fs.mkdir(path.dirname(beforeFile), { recursive: true })
    await fs.mkdir(path.dirname(afterFile), { recursive: true })
    await fs.writeFile(beforeFile, rawContent, 'utf8')
    await fs.writeFile(afterFile, newContent, 'utf8')

    let diffOut = ''
    try {
      const res = await execFileAsync(
        'git',
        ['diff', '--no-index', '--no-color', '-U3', `a/${repoPath}`, `b/${repoPath}`],
        { cwd: tmpDir }
      )
      diffOut = res.stdout
    } catch (err: unknown) {
      const cpErr = err as { code?: number; stdout?: string }
      if (cpErr.code === 1 && typeof cpErr.stdout === 'string') {
        diffOut = cpErr.stdout
      } else {
        throw new PatchError(`git diff --no-index failed: ${String(err)}`)
      }
    }

    if (!diffOut || diffOut.trim().length === 0) {
      throw new PatchError('Patch produced an empty diff')
    }

    // Rewrite headers to clean repo paths: --- a/<repoPath>, +++ b/<repoPath>
    diffOut = diffOut.replace(
      /^diff --git a\/.* b\/.*/m,
      `diff --git a/${repoPath} b/${repoPath}`
    )
    diffOut = diffOut.replace(/^--- a\/.*/m, `--- a/${repoPath}`)
    diffOut = diffOut.replace(/^\+\+\+ b\/.*/m, `+++ b/${repoPath}`)

    // Calculate added and removed stats
    let added = 0
    let removed = 0
    const diffLines = diffOut.split(/\r?\n/)
    for (const line of diffLines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added++
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed++
      }
    }

    if (added + removed > 60) {
      throw new PatchError(
        `Patch changes ${added + removed} lines (maximum allowed is 60)`
      )
    }

    // Verify patch application against actual workspace
    try {
      await runWithStdin(
        'git',
        ['-C', resolvedWorkspace, 'apply', '--check', '-'],
        diffOut
      )
    } catch (checkErr: unknown) {
      throw new PatchError(
        `git apply --check failed: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}`
      )
    }

    const id = createHash('sha1').update(diffOut).digest('hex').slice(0, 8)

    return {
      id,
      findingId: finding.id,
      file: repoPath,
      diff: diffOut,
      stats: { added, removed },
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Builds patches for all confirmed findings that have fixes.
 */
export const buildPatches = async (
  workspace: string,
  findings: Finding[]
): Promise<Patch[]> => {
  const patches: Patch[] = []
  for (const finding of findings) {
    if (finding.fix && finding.status === 'confirmed') {
      try {
        const patch = await buildPatch(workspace, finding)
        patches.push(patch)
      } catch (err: unknown) {
        console.warn(
          `[CodeSentinel] Failed to build patch for finding ${finding.id}:`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  }
  return patches
}

/**
 * Writes patch files to .CodeSentinel/patches/<id>.patch
 */
export const writePatchFiles = async (
  workspace: string,
  patches: Patch[]
): Promise<string[]> => {
  const patchDir = path.join(workspace, '.CodeSentinel', 'patches')
  await fs.mkdir(patchDir, { recursive: true })
  const writtenPaths: string[] = []
  for (const patch of patches) {
    const patchPath = path.join(patchDir, `${patch.id}.patch`)
    await fs.writeFile(patchPath, patch.diff, 'utf8')
    writtenPaths.push(patchPath)
  }
  return writtenPaths
}

/**
 * Applies a verified patch to the target workspace.
 */
export const applyPatch = async (
  workspace: string,
  patch: Patch | string
): Promise<void> => {
  const diff = typeof patch === 'string' ? patch : patch.diff
  const resolvedWorkspace = path.resolve(workspace)
  // First run --check
  await runWithStdin('git', ['-C', resolvedWorkspace, 'apply', '--check', '-'], diff)
  // Then apply
  await runWithStdin('git', ['-C', resolvedWorkspace, 'apply', '-'], diff)
}

/**
 * Applies approved patches (or edited replacement diffs) in the workspace.
 * Returns array of applied patch IDs.
 */
export const applyApproved = async (
  workspace: string,
  patches: Patch[],
  decisions: Record<string, 'approve' | 'reject' | { edit: string }>
): Promise<string[]> => {
  const applied: string[] = []
  const patchMap = new Map(patches.map((p) => [p.id, p]))

  for (const [patchId, decision] of Object.entries(decisions)) {
    if (decision === 'reject') continue

    const patch = patchMap.get(patchId)
    if (!patch) continue

    const diffToApply =
      typeof decision === 'object' && decision.edit ? decision.edit : patch.diff

    try {
      await applyPatch(workspace, diffToApply)
      applied.push(patchId)
    } catch (err: unknown) {
      console.warn(
        `[CodeSentinel] Failed to apply patch ${patchId}:`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  return applied
}
