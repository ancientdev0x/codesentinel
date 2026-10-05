import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBanditJson, runBandit } from '../../../src/review/analyzers/bandit'
import { isDockerAvailable, isDockerImageAvailable } from '../../../src/sandbox/docker'

const dockerAvailable = (await isDockerAvailable()) && (await isDockerImageAvailable())

describe('Bandit adapter (E3.3)', () => {
  it('parses real Bandit output fixture and maps to Finding models', () => {
    const fixturePath = join(__dirname, '../../fixtures/bandit-output.json')
    const rawJson = readFileSync(fixturePath, 'utf8')

    const { findings, error } = parseBanditJson(rawJson, '/workspace')
    expect(error).toBeUndefined()
    expect(findings.length).toBeGreaterThan(0)

    // B602: subprocess with shell=True -> critical, CWE-78
    const b602 = findings.find((f) => f.ruleId === 'B602')
    expect(b602).toBeDefined()
    expect(b602?.source).toBe('bandit')
    expect(b602?.severity).toBe('critical')
    expect(b602?.confidence).toBe('high')
    expect(b602?.cwe).toBe('CWE-78')
    expect(b602?.file).toBe('app/run.py')
    expect(b602?.startLine).toBe(5)
    expect(b602?.endLine).toBe(5)
    expect(b602?.status).toBe('candidate')

    // B608: SQL injection
    const b608 = findings.find((f) => f.ruleId === 'B608')
    expect(b608).toBeDefined()
    expect(b608?.cwe).toBe('CWE-89')
    expect(b608?.file).toBe('app/db.py')

    // B301: pickle deserialization
    const b301 = findings.find((f) => f.ruleId === 'B301')
    expect(b301).toBeDefined()
    expect(b301?.cwe).toBe('CWE-502')
    expect(b301?.file).toBe('app/store.py')

    // B506: yaml.load
    const b506 = findings.find((f) => f.ruleId === 'B506')
    expect(b506).toBeDefined()
    expect(b506?.file).toBe('app/yaml_load.py')
  })

  it('handles invalid JSON gracefully without throwing', () => {
    const { findings, error } = parseBanditJson('{ invalid json', '/workspace')
    expect(findings).toEqual([])
    expect(error).toContain('Invalid Bandit JSON')
  })

  it.runIf(dockerAvailable)(
    'integration: runs bandit inside docker against fixture files',
    async () => {
      const workspace = join(__dirname, '../../fixtures/vuln-repo/head')
      const files = ['app/run.py', 'app/calc.py', 'app/db.py']

      const { findings, runResult } = await runBandit(files, workspace, 'docker')

      expect(runResult.status).toBe('ok')
      expect(findings.length).toBeGreaterThan(0)
      const ruleIds = findings.map((f) => f.ruleId)
      expect(ruleIds).toContain('B602')
    }
  )
})
