import { Lang, type SgNode, parse, registerDynamicLanguage } from '@ast-grep/napi'
import python from '@ast-grep/lang-python'

let registered = false
export const ensureLangs = (): void => {
  if (!registered) {
    registerDynamicLanguage({ python })
    registered = true
  }
}

export type AstLang = 'python' | 'typescript' | 'tsx' | 'javascript'

const LANG_MAP: Record<Exclude<AstLang, 'python'>, Lang> = {
  typescript: Lang.TypeScript,
  tsx: Lang.Tsx,
  javascript: Lang.JavaScript,
}

export const langFor = (file: string): AstLang | undefined => {
  const lower = file.toLowerCase()
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.tsx')) return 'tsx'
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return 'typescript'
  }
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  ) {
    return 'javascript'
  }
  return undefined
}

export const to1BasedLine = (line0: number): number => line0 + 1
export const to0BasedLine = (line1: number): number => line1 - 1

export const nodeLineSpan = (node: SgNode): { startLine: number; endLine: number } => {
  const range = node.range()
  return {
    startLine: to1BasedLine(range.start.line),
    endLine: to1BasedLine(range.end.line),
  }
}

/**
 * Parses source code into an ast-grep root node.
 * Returns undefined and logs a warning on syntax/parsing failure so reviews never crash.
 */
export const parseFile = (lang: AstLang, source: string): SgNode | undefined => {
  try {
    ensureLangs()
    const napiLang = lang === 'python' ? 'python' : LANG_MAP[lang]
    return parse(napiLang, source).root()
  } catch (err) {
    console.warn(`[CodeSentinel] AST parse failed for ${lang}:`, err)
    return undefined
  }
}
