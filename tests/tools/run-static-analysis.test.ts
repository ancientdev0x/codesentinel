import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ReviewConfig } from '../../src/review/config'
import { createRunStaticAnalysisTool } from '../../src/tools/run-static-analysis'

describe('run_static_analysis tool (E3.6)', () => {
  const workspace = join(__dirname, '../fixtures/vuln-repo/head')
  const cfg: ReviewConfig = {
    platform: 'local',
    workspace,
    model: 'test-model',
    thinkingLevel: 'medium',
    reviewLanguage: 'English',
    telemetry: false,
    mcpServers: {},
    staticAnalysis: true,
    sandbox: 'host',
    analyzerTimeoutMs: 30000,
    astChecks: true,
    hitlMode: 'off',
  }

  const tool = createRunStaticAnalysisTool(cfg)

  it('rejects paths outside workspace', async () => {
    await expect(
      tool.run({
        input: {
          paths: ['../../outside.py'],
        },
      })
    ).rejects.toThrow(/outside workspace/)
  })

  it('runs analysis on valid files within workspace and returns JSON findings', async () => {
    const rawResult = await tool.run({
      input: {
        paths: ['web/broken.ts'],
        tools: ['tsc'],
      },
    })

    const parsed = JSON.parse(rawResult)
    expect(parsed.findingsCount).toBeGreaterThanOrEqual(1)
    expect(parsed.findings[0].source).toBe('tsc')
    expect(parsed.findings[0].file).toBe('web/broken.ts')
  })
})
