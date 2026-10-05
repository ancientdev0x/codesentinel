import { relative } from 'node:path'
import type { ReviewFileWithDiff } from './diff'
import type { CodeFragment } from './ast/fragments'
import { extractFragments } from './ast/fragments'
import { langFor } from './ast/parse'
import { type Finding, SEVERITY_ORDER } from './findings'
import { createFileInfo } from './prompt/fileInfo'

export interface ReviewPromptInput {
  files: ReviewFileWithDiff[]
  fragments?: CodeFragment[]
  findings?: Finding[]
  astChecks?: boolean
}

const formatFinding = (f: Finding, ws: string): string => {
  const filePath = relative(ws, f.file)
  const loc =
    f.startLine === f.endLine ? `L${f.startLine}` : `L${f.startLine}–L${f.endLine}`
  const sym = f.symbol ? ` in \`${f.symbol}\`` : ''
  const cwe = f.cwe ? ` [${f.cwe}]` : ''
  return `- \`${f.id}\` [${f.severity.toUpperCase()}] ${filePath}:${loc}${sym}${cwe} — ${f.message} (${f.source}:${f.ruleId})`
}

/**
 * Builds the user prompt for a review: a file tree with changed line ranges,
 * optional pre-detected findings, followed by AST code fragments (or diffs)
 * for each file under review.
 */
export function buildReviewPrompt(
  input: ReviewFileWithDiff[] | ReviewPromptInput,
  workspace: string
): string {
  const isArray = Array.isArray(input)
  const files = isArray ? input : input.files
  const astChecks = isArray ? false : (input.astChecks ?? true)
  const findings = isArray ? [] : (input.findings ?? [])

  const fileTree = createFileInfo(files, workspace)

  let findingsSection = ''
  if (findings.length > 0) {
    const sorted = [...findings]
      .sort((a, b) => {
        const aIdx = SEVERITY_ORDER.indexOf(a.severity)
        const bIdx = SEVERITY_ORDER.indexOf(b.severity)
        return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx)
      })
      .slice(0, 50)
    findingsSection = `\n\n## Pre-detected findings (verify each)\n${sorted.map((f) => formatFinding(f, workspace)).join('\n')}\n`
  }

  const fileBlocks: string[] = []

  for (const file of files) {
    const path = relative(workspace, file.fileName)
    const lang = langFor(file.fileName)

    if (!astChecks || file.isPureDeletion || !lang) {
      fileBlocks.push(`### ${path}\n\`\`\`diff\n${file.diff}\n\`\`\``)
      continue
    }

    const fileFrags =
      !isArray && input.fragments
        ? input.fragments.filter(
            (f) =>
              f.file === file.fileName ||
              f.file === path ||
              file.fileName.endsWith(f.file) ||
              f.file.endsWith(path)
          )
        : extractFragments(file, lang)

    if (fileFrags.length === 0) {
      fileBlocks.push(`### ${path}\n\`\`\`diff\n${file.diff}\n\`\`\``)
      continue
    }

    for (const frag of fileFrags) {
      const changedStr = frag.changedLines
        .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`))
        .join(', ')
      fileBlocks.push(
        `### ${path} › ${frag.symbol} (L${frag.startLine}–L${frag.endLine}, changed: ${changedStr})\n\`\`\`${frag.lang}\n${frag.code}\n\`\`\``
      )
    }

    if (file.changedLines.some((r) => r.isPureDeletion)) {
      fileBlocks.push(`### ${path}\n\`\`\`diff\n${file.diff}\n\`\`\``)
    }
  }

  const content = fileBlocks.join('\n\n')

  return `${fileTree}${findingsSection}
Below are the diffs for the files changed in this pull request. Review them, investigate the
surrounding code with your tools, and post inline comments on real problems with \`suggest_change\`.

${content}`
}
