import { execSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from '@langchain/langgraph'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { getOrCreateCollector } from '../../src/graph/collector'
import { buildReviewGraph } from '../../src/graph/review-graph'
import type { ReviewConfig } from '../../src/review/config'

describe('E5.2 human_review node with LangGraph interrupt()', () => {
  let tmpRepo: string

  beforeEach(async () => {
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'hitl-test-repo-'))
    execSync('git init', { cwd: tmpRepo })
    execSync('git config user.name "Test User"', { cwd: tmpRepo })
    execSync('git config user.email "test@example.com"', { cwd: tmpRepo })
  })

  afterEach(async () => {
    await fs.rm(tmpRepo, { recursive: true, force: true }).catch(() => {})
  })

  it('interrupts for interactive patch approval, resumes on Command({ resume }), and applies patch', async () => {
    const filePath = 'hello.ts'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.writeFile(fullPath, 'export const val = 100\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const runId = 'hitl-thread-1'
    process.env.CodeSentinel_RUN_ID = runId
    const collector = getOrCreateCollector(runId)
    collector.clear()

    const cfg: ReviewConfig = {
      platform: 'local',
      model: 'test/fake',
      thinkingLevel: 'off',
      reviewLanguage: 'English',
      ignore: [],
      telemetry: false,
      staticAnalysis: false,
      sandbox: 'none',
      analyzerTimeoutMs: 1000,
      astChecks: false,
      hitlMode: 'interactive',
      maxAttempts: 3,
      workspace: tmpRepo,
    }

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: async () => ({
          files: [
            {
              fileName: filePath,
              status: 'modified',
              additions: 1,
              deletions: 1,
              patch:
                '@@ -1,1 +1,1 @@\n-export const val = 100\n+export const val = 200\n',
              changedLines: [{ start: 1, end: 1 }],
            },
          ],
        }),
      },
      llmTriage: {
        session: { prompt: vi.fn().mockResolvedValue({ text: 'Summary' }) },
        tracedPrompt: vi.fn().mockImplementation(async () => {
          collector.recordFinding({
            file: filePath,
            startLine: 1,
            endLine: 1,
            severity: 'medium',
            message: 'Update val to 200',
            fix: {
              replacement: 'export const val = 200',
              startLine: 1,
              endLine: 1,
            },
          })
          return { text: 'Review completed summary' }
        }),
      },
    })

    const threadConfig = { configurable: { thread_id: runId } }

    // 1. Initial invoke: reaches human_review and pauses with interrupt
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const step1Result: any = await graph.invoke({ cfg }, threadConfig)

    expect(step1Result.__interrupt__).toBeDefined()
    expect(step1Result.__interrupt__.length).toBeGreaterThan(0)
    const interruptPayload = step1Result.__interrupt__[0].value
    expect(interruptPayload.type).toBe('patch_approval')
    expect(interruptPayload.patches).toHaveLength(1)
    const patchId = interruptPayload.patches[0].id
    expect(patchId).toMatch(/^[0-9a-f]{8}$/)

    // File before approval must still be unchanged
    const beforeApproval = await fs.readFile(fullPath, 'utf8')
    expect(beforeApproval).toBe('export const val = 100\n')

    // 2. Resume thread approving the patch
    const resumeCommand = new Command({
      resume: {
        [patchId]: 'approve',
      },
    })

    const step2Result: any = await graph.invoke(resumeCommand, threadConfig)

    // After approval, file must be modified by git apply
    const afterApproval = await fs.readFile(fullPath, 'utf8')
    expect(afterApproval).toBe('export const val = 200\n')

    expect(step2Result.applied).toContain(patchId)
    expect(step2Result.approvals[patchId]).toBe('approve')
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })

  it('rejects patch when resumed with "reject", leaving the working directory untouched', async () => {
    const filePath = 'hello.ts'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.writeFile(fullPath, 'export const val = 100\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const runId = 'hitl-thread-2'
    process.env.CodeSentinel_RUN_ID = runId
    const collector = getOrCreateCollector(runId)
    collector.clear()

    const cfg: ReviewConfig = {
      platform: 'local',
      model: 'test/fake',
      thinkingLevel: 'off',
      reviewLanguage: 'English',
      ignore: [],
      telemetry: false,
      staticAnalysis: false,
      sandbox: 'none',
      analyzerTimeoutMs: 1000,
      astChecks: false,
      hitlMode: 'interactive',
      maxAttempts: 3,
      workspace: tmpRepo,
    }

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: async () => ({
          files: [
            {
              fileName: filePath,
              status: 'modified',
              additions: 1,
              deletions: 1,
              patch:
                '@@ -1,1 +1,1 @@\n-export const val = 100\n+export const val = 300\n',
              changedLines: [{ start: 1, end: 1 }],
            },
          ],
        }),
      },
      llmTriage: {
        session: { prompt: vi.fn().mockResolvedValue({ text: 'Summary' }) },
        tracedPrompt: vi.fn().mockImplementation(async () => {
          collector.recordFinding({
            file: filePath,
            startLine: 1,
            endLine: 1,
            severity: 'medium',
            message: 'Update val to 300',
            fix: {
              replacement: 'export const val = 300',
              startLine: 1,
              endLine: 1,
            },
          })
          return { text: 'Review completed summary' }
        }),
      },
    })

    const threadConfig = { configurable: { thread_id: runId } }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const step1Result: any = await graph.invoke({ cfg }, threadConfig)
    const patchId = step1Result.__interrupt__[0].value.patches[0].id

    const resumeCommand = new Command({
      resume: {
        [patchId]: 'reject',
      },
    })

    const step2Result: any = await graph.invoke(resumeCommand, threadConfig)

    const finalContent = await fs.readFile(fullPath, 'utf8')
    expect(finalContent).toBe('export const val = 100\n')
    expect(step2Result.applied).toHaveLength(0)
    expect(step2Result.approvals[patchId]).toBe('reject')
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })

  it('supports edited patches with git apply --check re-validation', async () => {
    const filePath = 'hello.ts'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.writeFile(fullPath, 'export const val = 100\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const runId = 'hitl-thread-edit'
    process.env.CodeSentinel_RUN_ID = runId
    const collector = getOrCreateCollector(runId)
    collector.clear()

    const cfg: ReviewConfig = {
      platform: 'local',
      model: 'test/fake',
      thinkingLevel: 'off',
      reviewLanguage: 'English',
      ignore: [],
      telemetry: false,
      staticAnalysis: false,
      sandbox: 'none',
      analyzerTimeoutMs: 1000,
      astChecks: false,
      hitlMode: 'interactive',
      maxAttempts: 3,
      workspace: tmpRepo,
    }

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: async () => ({
          files: [
            {
              fileName: filePath,
              status: 'modified',
              additions: 1,
              deletions: 1,
              patch:
                '@@ -1,1 +1,1 @@\n-export const val = 100\n+export const val = 200\n',
              changedLines: [{ start: 1, end: 1 }],
            },
          ],
        }),
      },
      llmTriage: {
        session: { prompt: vi.fn().mockResolvedValue({ text: 'Summary' }) },
        tracedPrompt: vi.fn().mockImplementation(async () => {
          collector.recordFinding({
            file: filePath,
            startLine: 1,
            endLine: 1,
            severity: 'medium',
            message: 'Update val to 200',
            fix: {
              replacement: 'export const val = 200',
              startLine: 1,
              endLine: 1,
            },
          })
          return { text: 'Review completed summary' }
        }),
      },
    })

    const threadConfig = { configurable: { thread_id: runId } }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const step1Result: any = await graph.invoke({ cfg }, threadConfig)
    const patchId = step1Result.__interrupt__[0].value.patches[0].id

    const editedDiff = `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@ -1,1 +1,1 @@
-export const val = 100
+export const val = 999
`

    const resumeCommand = new Command({
      resume: {
        [patchId]: { edit: editedDiff },
      },
    })

    const step2Result: any = await graph.invoke(resumeCommand, threadConfig)

    const finalContent = await fs.readFile(fullPath, 'utf8')
    expect(finalContent).toBe('export const val = 999\n')
    expect(step2Result.applied).toContain(patchId)
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })

  it('handles hitlMode "terminal" by reading terminal decisions and applying approved patches directly', async () => {
    const filePath = 'hello.ts'
    const fullPath = path.join(tmpRepo, filePath)
    await fs.writeFile(fullPath, 'export const val = 100\n', 'utf8')
    execSync('git add . && git commit -m "initial"', { cwd: tmpRepo })

    const runId = 'hitl-thread-terminal'
    process.env.CodeSentinel_RUN_ID = runId
    const collector = getOrCreateCollector(runId)
    collector.clear()

    const cfg: ReviewConfig = {
      platform: 'local',
      model: 'test/fake',
      thinkingLevel: 'off',
      reviewLanguage: 'English',
      ignore: [],
      telemetry: false,
      staticAnalysis: false,
      sandbox: 'none',
      analyzerTimeoutMs: 1000,
      astChecks: false,
      hitlMode: 'terminal',
      maxAttempts: 3,
      workspace: tmpRepo,
    }

    const graph = buildReviewGraph({
      ingest: {
        getChangedFiles: async () => ({
          files: [
            {
              fileName: filePath,
              status: 'modified',
              additions: 1,
              deletions: 1,
              patch:
                '@@ -1,1 +1,1 @@\n-export const val = 100\n+export const val = 500\n',
              changedLines: [{ start: 1, end: 1 }],
            },
          ],
        }),
      },
      llmTriage: {
        session: { prompt: vi.fn().mockResolvedValue({ text: 'Summary' }) },
        tracedPrompt: vi.fn().mockImplementation(async () => {
          collector.recordFinding({
            file: filePath,
            startLine: 1,
            endLine: 1,
            severity: 'medium',
            message: 'Update val to 500',
            fix: {
              replacement: 'export const val = 500',
              startLine: 1,
              endLine: 1,
            },
          })
          return { text: 'Review completed summary' }
        }),
      },
      humanReview: {
        promptTerminalDecisions: async (_ws, patches) => {
          const decisions: Record<string, 'approve'> = {}
          for (const p of patches) {
            decisions[p.id] = 'approve'
          }
          return decisions
        },
      },
    })

    const threadConfig = { configurable: { thread_id: runId } }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const result: any = await graph.invoke({ cfg }, threadConfig)

    // In terminal mode, no __interrupt__ is triggered because decisions were read directly
    expect(result.__interrupt__).toBeUndefined()
    expect(result.applied).toHaveLength(1)

    const finalContent = await fs.readFile(fullPath, 'utf8')
    expect(finalContent).toBe('export const val = 500\n')
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })
})
