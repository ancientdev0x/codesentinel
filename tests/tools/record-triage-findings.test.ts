import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateCollector } from '../../src/graph/collector'
import { createRecordFindingTool } from '../../src/tools/record-finding'
import { createTriageFindingTool } from '../../src/tools/triage-finding'

describe('record_finding and triage_finding tools (E4.3)', () => {
  const runId = 'test-run-collector'

  beforeEach(() => {
    process.env.CodeSentinel_RUN_ID = runId
    const collector = getOrCreateCollector(runId)
    collector.clear()
  })

  it('records finding into collector and returns recorded <id>', async () => {
    const recordTool = createRecordFindingTool()
    const result = await (recordTool as any).run({
      input: {
        file: 'src/auth/login.py',
        startLine: 10,
        endLine: 12,
        severity: 'high',
        message: 'Hardcoded credentials in login routine',
        cwe: 'CWE-798',
      },
    })

    expect(result).toMatch(/^recorded [a-f0-9]+$/)

    const collector = getOrCreateCollector(runId)
    const findings = collector.getFindings()
    expect(findings).toHaveLength(1)
    expect(findings[0].file).toBe('src/auth/login.py')
    expect(findings[0].severity).toBe('high')
    expect(findings[0].cwe).toBe('CWE-798')
  })

  it('throws on invalid line ranges (startLine > endLine)', async () => {
    const recordTool = createRecordFindingTool()
    await expect(
      (recordTool as any).run({
        input: {
          file: 'src/main.ts',
          startLine: 20,
          endLine: 10,
          severity: 'medium',
          message: 'Line order error',
        },
      })
    ).rejects.toThrow(/startLine \(20\) cannot be greater than endLine \(10\)/)
  })

  it('triages pre-detected finding into collector', async () => {
    const triageTool = createTriageFindingTool()
    const result = await (triageTool as any).run({
      input: {
        id: 'finding-123',
        decision: 'confirm',
        rationale: 'Verified vulnerability in tainted user input',
      },
    })

    expect(result).toBe('triaged finding-123 as confirm')

    const collector = getOrCreateCollector(runId)
    const decisions = collector.getTriageDecisions()
    expect(decisions.get('finding-123')).toEqual({
      decision: 'confirm',
      rationale: 'Verified vulnerability in tainted user input',
    })
  })
})
