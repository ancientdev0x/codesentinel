import { existsSync, promises as fsp } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTscOutput, runTsc } from '../../../src/review/analyzers/typescript'

describe('TypeScript analyzer adapter (E3.5)', () => {
  it('parses tsc error lines into Finding models tagged as regressions', () => {
    const rawOutput = [
      "web/broken.ts(2,9): error TS2322: Type 'number' is not assignable to type 'string'.",
      "web/other.ts(10,5): error TS7006: Parameter 'x' implicitly has an 'any' type.",
    ].join('\n')

    const findings = parseTscOutput(rawOutput, '/workspace', ['web/broken.ts'])

    expect(findings).toHaveLength(1)
    const broken = findings[0]
    expect(broken.source).toBe('tsc')
    expect(broken.ruleId).toBe('TS2322')
    expect(broken.severity).toBe('high')
    expect(broken.rationale).toBe('regression')
    expect(broken.file).toBe('web/broken.ts')
    expect(broken.startLine).toBe(2)
    expect(broken.endLine).toBe(2)
    expect(broken.message).toContain("Type 'number' is not assignable to type 'string'.")
  })

  it('runs tsc against fixture workspace and detects broken.ts regression', async () => {
    const workspace = join(__dirname, '../../fixtures/vuln-repo/head')
    const changedFiles = ['web/broken.ts', 'web/clean_format.ts', 'web/clean_sanitize.ts']

    const { findings, runResult } = await runTsc(changedFiles, workspace)

    expect(runResult?.status).toBe('ok')
    expect(findings.length).toBeGreaterThanOrEqual(1)

    const brokenFinding = findings.find((f) => f.file.endsWith('broken.ts'))
    expect(brokenFinding).toBeDefined()
    expect(brokenFinding?.ruleId).toBe('TS2322')
    expect(brokenFinding?.rationale).toBe('regression')
    expect(brokenFinding?.severity).toBe('high')

    // Clean files should have 0 findings
    const cleanFindings = findings.filter(
      (f) => f.file.endsWith('clean_format.ts') || f.file.endsWith('clean_sanitize.ts')
    )
    expect(cleanFindings).toHaveLength(0)
  })

  it('returns empty findings if workspace has no tsconfig.json', async () => {
    const workspace = join(__dirname, '../../fixtures')
    const { findings } = await runTsc(['web/broken.ts'], workspace)
    expect(findings).toEqual([])
  })

  it('does NOT execute fake tsc from workspace node_modules/.bin and runs real tsc', async () => {
    const tmp = await fsp.mkdtemp(join(os.tmpdir(), 'tsc-security-'))
    try {
      const binDir = join(tmp, 'node_modules', '.bin')
      await fsp.mkdir(binDir, { recursive: true })
      const markerPath = join(tmp, 'malicious-marker.txt')
      const fakeTscPath = join(binDir, 'tsc')
      await fsp.writeFile(
        fakeTscPath,
        `#!/usr/bin/env node\nconst fs = require('fs'); fs.writeFileSync(${JSON.stringify(markerPath)}, 'pwned');\n`,
        { mode: 0o755 }
      )

      await fsp.writeFile(
        join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { noEmit: true, target: 'esnext' },
          include: ['test.ts'],
        })
      )
      await fsp.writeFile(join(tmp, 'test.ts'), 'const a: string = 123;\n')

      const { findings, runResult } = await runTsc(['test.ts'], tmp)

      expect(existsSync(markerPath)).toBe(false)
      expect(runResult?.status).toBe('ok')
      expect(findings.length).toBeGreaterThanOrEqual(1)
      expect(findings[0].ruleId).toBe('TS2322')
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })
})
