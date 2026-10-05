import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBanditJson } from '../../../src/review/analyzers/bandit'
import { parseRuffJson, runRuff } from '../../../src/review/analyzers/ruff'
import { dedupeFindings } from '../../../src/review/findings'
import { isDockerAvailable, isDockerImageAvailable } from '../../../src/sandbox/docker'

const dockerAvailable = (await isDockerAvailable()) && (await isDockerImageAvailable())

describe('Ruff adapter (E3.4)', () => {
  it('parses real Ruff output fixture, maps to Finding models, tags regressions and fixes', () => {
    const fixturePath = join(__dirname, '../../fixtures/ruff-output.json')
    const rawJson = readFileSync(fixturePath, 'utf8')

    const { findings, error } = parseRuffJson(rawJson, '/workspace')
    expect(error).toBeUndefined()
    expect(findings.length).toBeGreaterThan(0)

    // S602: subprocess with shell=True -> critical
    const s602 = findings.find((f) => f.ruleId === 'S602')
    expect(s602).toBeDefined()
    expect(s602?.source).toBe('ruff')
    expect(s602?.severity).toBe('critical')
    expect(s602?.file).toBe('app/run.py')
    expect(s602?.startLine).toBe(5)

    // F821: undefined name -> high severity regression
    const f821 = findings.find((f) => f.ruleId === 'F821')
    expect(f821).toBeDefined()
    expect(f821?.severity).toBe('high')
    expect(f821?.rationale).toBe('regression')
    expect(f821?.message).toContain('[regression]')
    expect(f821?.message).toContain('undefined_variable_name')
    expect(f821?.file).toBe('app/regress.py')

    // F401: unused import with fix edits
    const f401 = findings.find((f) => f.ruleId === 'F401')
    expect(f401).toBeDefined()
    expect(f401?.fix).toBeDefined()
    expect(f401?.fix?.startLine).toBe(1)
    expect(f401?.fix?.endLine).toBe(2)
  })

  it('dedupes Ruff S602 against Bandit B602 into a single unified finding', () => {
    const banditFixture = readFileSync(
      join(__dirname, '../../fixtures/bandit-output.json'),
      'utf8'
    )
    const ruffFixture = readFileSync(
      join(__dirname, '../../fixtures/ruff-output.json'),
      'utf8'
    )

    const { findings: banditFindings } = parseBanditJson(banditFixture, '/workspace')
    const { findings: ruffFindings } = parseRuffJson(ruffFixture, '/workspace')

    const b602 = banditFindings.find((f) => f.ruleId === 'B602')!
    const s602 = ruffFindings.find((f) => f.ruleId === 'S602')!

    expect(b602).toBeDefined()
    expect(s602).toBeDefined()

    // Both are at app/run.py line 5 with CWE-78
    const deduped = dedupeFindings([b602, s602])
    expect(deduped).toHaveLength(1)
    expect(deduped[0].file).toBe('app/run.py')
    expect(deduped[0].startLine).toBe(5)
    expect(deduped[0].message).toContain('also reported by ruff')
  })

  it('handles invalid JSON gracefully without throwing', () => {
    const { findings, error } = parseRuffJson('bad json', '/workspace')
    expect(findings).toEqual([])
    expect(error).toContain('Invalid Ruff JSON')
  })

  it.runIf(dockerAvailable)(
    'integration: runs ruff inside docker against fixture files',
    async () => {
      const workspace = join(__dirname, '../../fixtures/vuln-repo/head')
      const files = ['app/run.py', 'app/regress.py', 'app/db.py']

      const { findings, runResult } = await runRuff(files, workspace, 'docker')

      expect(runResult.status).toBe('ok')
      expect(findings.length).toBeGreaterThan(0)
      const ruleIds = findings.map((f) => f.ruleId)
      expect(ruleIds).toContain('S602')
      expect(ruleIds).toContain('F821')
    }
  )
})
