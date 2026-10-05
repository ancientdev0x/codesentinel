import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface LabelEntry {
  file: string
  line?: number
  cwe?: string
  kind: 'vuln' | 'regression' | 'clean'
  detector?: string
}

describe('Ground-truth labels (E7.1)', () => {
  const labelsPath = join(__dirname, '../fixtures/vuln-repo.labels.json')
  const fixtureHeadDir = join(__dirname, '../fixtures/vuln-repo/head')

  it('labels file exists and is valid JSON', () => {
    expect(existsSync(labelsPath)).toBe(true)
    const raw = readFileSync(labelsPath, 'utf8')
    const labels: LabelEntry[] = JSON.parse(raw)
    expect(Array.isArray(labels)).toBe(true)
  })

  it('contains at least 20 labeled issues across Python and TS', () => {
    const labels: LabelEntry[] = JSON.parse(readFileSync(labelsPath, 'utf8'))
    expect(labels.length).toBeGreaterThanOrEqual(20)

    const pyLabels = labels.filter((l) => l.file.endsWith('.py'))
    const tsLabels = labels.filter((l) => l.file.endsWith('.ts'))
    expect(pyLabels.length).toBeGreaterThanOrEqual(5)
    expect(tsLabels.length).toBeGreaterThanOrEqual(5)
  })

  it('every labeled file exists in fixture head directory', () => {
    const labels: LabelEntry[] = JSON.parse(readFileSync(labelsPath, 'utf8'))
    for (const label of labels) {
      const fullPath = join(fixtureHeadDir, label.file)
      expect(existsSync(fullPath), `File should exist: ${label.file}`).toBe(true)
    }
  })

  it('includes clean files and subtle logic regressions', () => {
    const labels: LabelEntry[] = JSON.parse(readFileSync(labelsPath, 'utf8'))
    const cleanFiles = labels.filter((l) => l.kind === 'clean')
    expect(cleanFiles.length).toBeGreaterThanOrEqual(3)

    const regressions = labels.filter((l) => l.kind === 'regression')
    expect(regressions.length).toBeGreaterThanOrEqual(3)

    // LLM-targeted subtle logic regressions
    const llmRegressions = regressions.filter((l) => l.detector === 'llm')
    expect(llmRegressions.length).toBeGreaterThanOrEqual(2)
  })

  it('covers major CWE categories from AST and static rules', () => {
    const labels: LabelEntry[] = JSON.parse(readFileSync(labelsPath, 'utf8'))
    const cwes = new Set(labels.map((l) => l.cwe).filter(Boolean))

    expect(cwes).toContain('CWE-78') // Command injection
    expect(cwes).toContain('CWE-89') // SQL injection
    expect(cwes).toContain('CWE-95') // Eval/code execution
    expect(cwes).toContain('CWE-502') // Deserialization
    expect(cwes).toContain('CWE-798') // Hardcoded credentials
    expect(cwes).toContain('CWE-79') // XSS
    expect(cwes).toContain('CWE-295') // TLS cert verification
  })
})
