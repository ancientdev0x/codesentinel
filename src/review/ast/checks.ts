import type { LineRange } from '../../common/types'
import type { ReviewFileWithDiff } from '../diff'
import { type Finding, findingId, normalizeFindingPath, onlyChanged } from '../findings'
import { buildSymbolName } from './fragments'
import { langFor, nodeLineSpan, parseFile } from './parse'
import { getRulesFor } from './rules'

/**
 * Runs AST-based security checks using ast-grep rules on changed files.
 * Restricts findings to changed lines and respects a 2s per-file timeout.
 */
export const runAstChecks = (
  files: ReviewFileWithDiff[],
  workspace?: string
): Finding[] => {
  const allFindings: Finding[] = []

  for (const file of files) {
    if (file.isPureDeletion || !file.fileContent) {
      continue
    }

    const lang = langFor(file.fileName)
    if (!lang) {
      continue
    }

    const normFilePath = normalizeFindingPath(file.fileName, workspace)

    const startTime = Date.now()
    let root
    try {
      root = parseFile(lang, file.fileContent)
    } catch {
      continue
    }
    if (!root) {
      continue
    }

    const rules = getRulesFor(lang)
    for (const rule of rules) {
      // Guard against pathological files with a 2-second per-file budget
      if (Date.now() - startTime > 2000) {
        break
      }

      let matches
      try {
        matches = root.findAll({ rule: rule.rule })
      } catch {
        continue
      }

      for (const match of matches) {
        const { startLine, endLine } = nodeLineSpan(match)
        const symbol = buildSymbolName(match, root)
        const finding: Finding = {
          id: findingId({
            source: 'ast-grep',
            ruleId: rule.id,
            file: normFilePath,
            startLine,
          }),
          source: 'ast-grep',
          ruleId: rule.id,
          severity: rule.severity,
          confidence: 'high',
          file: normFilePath,
          startLine,
          endLine,
          message: rule.message,
          cwe: rule.metadata.cwe,
          symbol,
          status: 'candidate',
        }
        allFindings.push(finding)
      }
    }
  }

  const changedMap = new Map<string, LineRange[]>()
  for (const file of files) {
    const norm = normalizeFindingPath(file.fileName, workspace)
    changedMap.set(norm, file.changedLines)
    changedMap.set(file.fileName, file.changedLines)
  }

  return onlyChanged(allFindings, changedMap)
}
