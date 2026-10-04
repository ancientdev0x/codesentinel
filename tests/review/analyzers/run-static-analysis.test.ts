import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDockerAvailable } from '../../../src/sandbox/docker'
import { runStaticAnalysis } from '../../../src/review/analyzers'
import type { ReviewConfig } from '../../../src/review/config'

const dockerAvailable = await isDockerAvailable()

describe('runStaticAnalysis end-to-end against E0.5 fixture repo', () => {
  it.runIf(dockerAvailable)(
    'finds bandit and ruff vulnerabilities and tsc error on fixture workspace',
    async () => {
      const workspace = join(__dirname, '../../fixtures/vuln-repo/head')
      const files = [
        join(workspace, 'app/run.py'),
        join(workspace, 'app/db.py'),
        join(workspace, 'app/store.py'),
        join(workspace, 'app/calc.py'),
        join(workspace, 'app/yaml_load.py'),
        join(workspace, 'app/regress.py'),
        join(workspace, 'web/broken.ts'),
      ]

      const cfg: ReviewConfig = {
        platform: 'local',
        workspace,
        model: 'anthropic/claude-3-5-sonnet',
        thinkingLevel: 'off',
        reviewLanguage: 'en',
        ignore: [],
        telemetry: false,
        staticAnalysis: true,
        sandbox: 'docker',
        analyzerTimeoutMs: 30_000,
        astChecks: true,
        hitlMode: 'off',
        maxAttempts: 3,
      }

      const result = await runStaticAnalysis(cfg, files)

      expect(result.findings.length).toBeGreaterThan(0)

      // Bandit & Ruff findings
      const rulesFound = new Set(result.findings.map((f) => f.ruleId))
      expect(rulesFound.has('B602') || rulesFound.has('S602')).toBe(true)
      expect(rulesFound.has('B608') || rulesFound.has('S608')).toBe(true)
      expect(rulesFound.has('B301') || rulesFound.has('S301')).toBe(true)
      expect(rulesFound.has('B307') || rulesFound.has('S307')).toBe(true)
      expect(rulesFound.has('F821')).toBe(true)

      // TSC finding
      expect(rulesFound.has('TS2322')).toBe(true)

      // Reports generated
      expect(result.reports.length).toBe(3)
      const reportTools = result.reports.map((r) => r.tool)
      expect(reportTools).toContain('bandit')
      expect(reportTools).toContain('ruff')
      expect(reportTools).toContain('tsc')

      for (const r of result.reports) {
        expect(r.status).toBe('ok')
        expect(r.findings).toBeGreaterThan(0)
      }
    },
    30_000
  )
})
