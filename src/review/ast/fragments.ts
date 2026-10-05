import type { SgNode } from '@ast-grep/napi'
import type { LineRange } from '../../common/types'
import type { ReviewFileWithDiff } from '../diff'
import { type AstLang, langFor, nodeLineSpan, parseFile, to0BasedLine } from './parse'

export interface CodeFragment {
  file: string
  lang: AstLang
  symbol: string // "UserService.save", "<module>"
  kind: string // function_definition | method_definition | class_declaration | ...
  startLine: number
  endLine: number // 1-based, full node span
  changedLines: LineRange[] // the intersection with the diff
  code: string // node.text(), capped at 300 lines with "…truncated"
}

const MAX_FRAGMENT_LINES = 300

export const truncateCode = (code: string, maxLines = MAX_FRAGMENT_LINES): string => {
  const lines = code.split('\n')
  if (lines.length <= maxLines) return code
  return `${lines.slice(0, maxLines).join('\n')}\n…truncated`
}

const PYTHON_UNITS = new Set([
  'function_definition',
  'class_definition',
  'decorated_definition',
])

const TS_JS_UNITS = new Set([
  'function_declaration',
  'method_definition',
  'class_declaration',
])

/**
 * Finds the smallest AST node covering the specified 0-based line number.
 */
const findSmallestNode = (node: SgNode, line0: number): SgNode => {
  for (const child of node.children()) {
    const range = child.range()
    if (range.start.line <= line0 && range.end.line >= line0) {
      return findSmallestNode(child, line0)
    }
  }
  return node
}

/**
 * Determines whether a node is a unit definition for the given language.
 */
const isUnitNode = (node: SgNode, lang: AstLang, root: SgNode): boolean => {
  const kind = String(node.kind())
  if (lang === 'python') {
    return PYTHON_UNITS.has(kind)
  }

  if (TS_JS_UNITS.has(kind)) {
    return true
  }

  // Arrow function assigned to a variable declarator (e.g. const fn = () => {})
  if (kind === 'arrow_function') {
    const parent = node.parent()
    if (parent && parent.kind() === 'variable_declarator') {
      return true
    }
  }

  // Lexical declaration at top level
  if (kind === 'lexical_declaration' || kind === 'variable_declaration') {
    const parent = node.parent()
    if (parent && (parent.id() === root.id() || parent.kind() === 'export_statement')) {
      return true
    }
  }

  return false
}

/**
 * Normalizes unit node (e.g. expanding arrow_function to its parent declaration).
 */
const normalizeUnitNode = (node: SgNode): SgNode => {
  if (node.kind() === 'arrow_function') {
    const parent = node.parent()
    if (parent && parent.kind() === 'variable_declarator') {
      const decl = parent.parent()
      if (
        decl &&
        (decl.kind() === 'lexical_declaration' || decl.kind() === 'variable_declaration')
      ) {
        return decl
      }
      return parent
    }
  }
  return node
}

/**
 * Resolves the unit node covering target line. Falls back to top-level statement.
 */
const findEnclosingUnit = (root: SgNode, line0: number, lang: AstLang): SgNode => {
  const leaf = findSmallestNode(root, line0)
  let curr: SgNode | null = leaf
  let topLevelStatement: SgNode = leaf

  while (curr && curr.id() !== root.id()) {
    if (isUnitNode(curr, lang, root)) {
      return normalizeUnitNode(curr)
    }
    const parentNode: SgNode | null = curr.parent()
    if (parentNode && parentNode.id() === root.id()) {
      topLevelStatement = curr
    }
    curr = parentNode
  }

  return topLevelStatement
}

/**
 * Extracts a name component from a node.
 */
const getNodeName = (node: SgNode): string | undefined => {
  const kind = String(node.kind())
  if (
    kind === 'function_declaration' ||
    kind === 'function_definition' ||
    kind === 'method_definition' ||
    kind === 'class_declaration' ||
    kind === 'class_definition'
  ) {
    return node.field('name')?.text()
  }

  if (kind === 'decorated_definition') {
    const def = node.field('definition')
    if (def) return def.field('name')?.text()
    const innerFn = node.find({ rule: { kind: 'function_definition' } })
    return innerFn?.field('name')?.text()
  }

  if (kind === 'variable_declarator') {
    return node.field('name')?.text()
  }

  if (kind === 'lexical_declaration' || kind === 'variable_declaration') {
    const decl = node.find({ rule: { kind: 'variable_declarator' } })
    return decl?.field('name')?.text()
  }

  return undefined
}

/**
 * Builds the symbol name (e.g. "UserService.save" or "<module>") by walking up enclosing scopes.
 */
export const buildSymbolName = (unit: SgNode, root: SgNode): string => {
  const parts: string[] = []
  const selfName = getNodeName(unit)
  if (selfName) {
    parts.unshift(selfName)
  }

  let curr = unit.parent()
  while (curr && curr.id() !== root.id()) {
    const parentName = getNodeName(curr)
    if (parentName && !parts.includes(parentName)) {
      parts.unshift(parentName)
    }
    curr = curr.parent()
  }

  if (parts.length === 0) {
    return '<module>'
  }
  return parts.join('.')
}

/**
 * Extracts code fragments enclosing changed line ranges in a diff.
 * Returns whole parseable syntactic units with symbol names.
 */
export const extractFragments = (
  file: ReviewFileWithDiff,
  lang: AstLang
): CodeFragment[] => {
  if (file.isPureDeletion || !file.fileContent?.trim()) {
    return []
  }

  if (!file.changedLines || file.changedLines.length === 0) {
    return []
  }

  const root = parseFile(lang, file.fileContent)
  if (!root) {
    return []
  }

  const fragmentsByNodeId = new Map<number, CodeFragment>()

  for (const range of file.changedLines) {
    // Diff lines are 1-based; ast-grep is 0-based
    const line0 = to0BasedLine(Math.max(1, range.start))
    const unitNode = findEnclosingUnit(root, line0, lang)
    const { startLine, endLine } = nodeLineSpan(unitNode)

    const existing = fragmentsByNodeId.get(unitNode.id())
    if (existing) {
      existing.changedLines.push(range)
    } else {
      const symbol = buildSymbolName(unitNode, root)
      const rawCode = unitNode.text()
      const code = truncateCode(rawCode)

      fragmentsByNodeId.set(unitNode.id(), {
        file: file.fileName,
        lang,
        symbol,
        kind: String(unitNode.kind()),
        startLine,
        endLine,
        changedLines: [range],
        code,
      })
    }
  }

  // Sort fragments by startLine in ascending order
  return Array.from(fragmentsByNodeId.values()).sort((a, b) => a.startLine - b.startLine)
}

/**
 * Extracts fragments for all changed files whose language is supported.
 */
export const extractAllFragments = (files: ReviewFileWithDiff[]): CodeFragment[] => {
  return files.flatMap((f) => {
    const lang = langFor(f.fileName)
    return lang ? extractFragments(f, lang) : []
  })
}
