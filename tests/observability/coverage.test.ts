import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { setLangfuseTracerProvider } from '@langfuse/tracing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import qaLead from '../../src/agents/qa-lead'
import reviewer from '../../src/agents/reviewer'
import { healerProfile } from '../../src/qa/healer'
import { isTraced } from '../../src/observability/tools'
import { validateTraceMetadata, withNodeSpan } from '../../src/observability/trace'
import * as v from 'valibot'

describe('Observability strict coverage & pipeline guarantees (E6.6)', () => {
  describe('1. Every tool is traced', () => {
    it('asserts that every tool on reviewer agent is traced', async () => {
      const cfg = await reviewer.initialize({
        id: 'test-coverage-reviewer',
        env: { GITHUB_WORKSPACE: process.cwd() },
      })

      expect(Array.isArray(cfg.tools)).toBe(true)
      const tools = cfg.tools as Array<unknown>
      expect(tools.length).toBeGreaterThan(0)

      for (const tool of tools) {
        expect(
          isTraced(tool),
          `Tool ${(tool as { name?: string }).name} on reviewer agent must be wrapped with traced()`
        ).toBe(true)
      }
    })

    it('asserts that every tool on qa-lead agent is traced', async () => {
      const cfg = await qaLead.initialize({
        id: 'test-coverage-qa-lead',
        env: { GITHUB_WORKSPACE: process.cwd() },
      })

      expect(Array.isArray(cfg.tools)).toBe(true)
      const tools = cfg.tools as Array<unknown>
      expect(tools.length).toBeGreaterThan(0)

      for (const tool of tools) {
        expect(
          isTraced(tool),
          `Tool ${(tool as { name?: string }).name} on qa-lead agent must be wrapped with traced()`
        ).toBe(true)
      }
    })

    it('asserts that every tool on healer subagent profile is traced', () => {
      const profile = healerProfile({
        target: 'http://localhost:3000',
        workspace: process.cwd(),
        model: 'anthropic/claude-3-5-sonnet',
        thinkingLevel: 'high',
        kind: 'web',
        scope: [],
      })

      expect(Array.isArray(profile.tools)).toBe(true)
      const tools = profile.tools as Array<unknown>
      expect(tools.length).toBeGreaterThan(0)

      for (const tool of tools) {
        expect(
          isTraced(tool),
          `Tool ${(tool as { name?: string }).name} on healer profile must be wrapped with traced()`
        ).toBe(true)
      }
    })
  })

  describe('2. Node tracing sequence & cycling with InMemorySpanExporter', () => {
    let memoryExporter: InMemorySpanExporter
    let provider: BasicTracerProvider

    beforeEach(async () => {
      memoryExporter = new InMemorySpanExporter()
      provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
      })
      setLangfuseTracerProvider(provider)
    })

    afterEach(async () => {
      await provider.shutdown()
      memoryExporter.reset()
    })

    it('records node span sequence and cycles with attempt counter', async () => {
      interface MockState {
        attempts: Record<string, number>
        step: string
      }

      const nodeIngest = withNodeSpan('ingest', async (_s: MockState) => ({
        step: 'ingested',
      }))
      const nodeAst = withNodeSpan('extract_ast', async (_s: MockState) => ({
        step: 'extracted',
      }))
      const nodeAnalysis = withNodeSpan('static_analysis', async (_s: MockState) => ({
        step: 'analyzed',
      }))
      const nodeTriage = withNodeSpan('llm_triage', async (s: MockState) => ({
        step: `triage_${s.attempts.llm_triage}`,
      }))

      const state: MockState = {
        attempts: { llm_triage: 1 },
        step: 'init',
      }

      await nodeIngest(state)
      await nodeAst(state)
      await nodeAnalysis(state)
      await nodeTriage(state)

      // Simulate a cycle in state machine (attempt 2)
      state.attempts.llm_triage = 2
      await nodeTriage(state)

      const spans = memoryExporter.getFinishedSpans()
      const spanNames = spans.map((s) => s.name)

      expect(spanNames).toContain('node.ingest')
      expect(spanNames).toContain('node.extract_ast')
      expect(spanNames).toContain('node.static_analysis')
      expect(spanNames.filter((n) => n === 'node.llm_triage').length).toBe(2)

      const triageSpans = spans.filter((s) => s.name === 'node.llm_triage')
      expect(triageSpans.length).toBe(2)
    })
  })

  describe('3. Metadata schema validation', () => {
    it('validates compliant trace metadata', () => {
      const validMeta = {
        repo: 'octocat/Hello-World',
        pr: 42,
        runId: 'run-9988',
        model: 'anthropic/claude-3-5-sonnet',
        platform: 'github' as const,
      }

      const parsed = validateTraceMetadata(validMeta)
      expect(parsed).toEqual(validMeta)
    })

    it('rejects invalid trace metadata missing required fields', () => {
      const invalidMeta = {
        repo: 'octocat/Hello-World',
        // missing pr, runId, model, platform
      }

      expect(() => validateTraceMetadata(invalidMeta)).toThrow(v.ValiError)
    })

    it('rejects invalid platform specifier', () => {
      const invalidPlatform = {
        repo: 'octocat/Hello-World',
        pr: 1,
        runId: 'run-1',
        model: 'm',
        platform: 'unsupported-platform',
      }

      expect(() => validateTraceMetadata(invalidPlatform)).toThrow(v.ValiError)
    })
  })

  describe('4. Flush guarantee', () => {
    it('ensures flushTracing is executed in finally block of review workflow', async () => {
      const { tracingLifecycle } = await import('../../src/observability/langfuse')
      const { default: reviewWorkflow } = await import('../../src/workflows/review')

      tracingLifecycle.reset()

      const fakeSession = {
        prompt: vi.fn().mockResolvedValue({ text: 'Review summary', usage: {} }),
      }
      const fakeHarness = {
        session: vi.fn().mockResolvedValue(fakeSession),
      }

      // Test path 1: normal or handled workflow execution
      try {
        await (reviewWorkflow as any).action.run({
          harness: fakeHarness,
          log: {},
          input: {
            platform: 'local',
            workspace: process.cwd(),
            staticAnalysis: false,
            astChecks: false,
          },
        })
      } catch {
        // Handled/thrown
      }
      expect(tracingLifecycle.flushCount).toBeGreaterThan(0)

      tracingLifecycle.reset()

      // Test path 2: thrown error path
      const failingHarness = {
        session: vi.fn().mockRejectedValue(new Error('Simulated failure')),
      }
      try {
        await (reviewWorkflow as any).action.run({
          harness: failingHarness,
          log: {},
          input: {
            platform: 'local',
            workspace: process.cwd(),
            staticAnalysis: false,
            astChecks: false,
          },
        })
      } catch {
        // Expected throw
      }
      expect(tracingLifecycle.flushCount).toBeGreaterThan(0)
    }, 15000)
  })
})
