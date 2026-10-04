import { defineTool } from '@flue/runtime'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { isTraced, traced, traceTools, TRACED } from '../../src/observability/tools'

describe('Tool tracing wrapper (E6.3)', () => {
  it('marks wrapped tool with TRACED symbol', () => {
    const rawTool = defineTool({
      name: 'test_tool',
      description: 'A test tool',
      input: v.object({ msg: v.string() }),
      run: async ({ input }) => `Echo: ${input.msg}`,
    })

    expect(isTraced(rawTool)).toBe(false)
    const wrapped = traced(rawTool)
    expect(isTraced(wrapped)).toBe(true)
    expect((wrapped as Record<symbol, unknown>)[TRACED]).toBe(true)
  })

  it('is idempotent when wrapping an already traced tool', () => {
    const rawTool = defineTool({
      name: 'test_tool_2',
      description: 'Test',
      run: async () => 'ok',
    })
    const wrapped1 = traced(rawTool)
    const wrapped2 = traced(wrapped1)
    expect(wrapped1).toBe(wrapped2)
  })

  it('executes tool logic successfully through wrapped runner', async () => {
    let called = false
    const rawTool = defineTool({
      name: 'calc_tool',
      description: 'Does math',
      input: v.object({ x: v.number(), y: v.number() }),
      run: async ({ input }) => {
        called = true
        return input.x + input.y
      },
    })

    const wrapped = traced(rawTool)
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (wrapped as any).run({ input: { x: 3, y: 7 } })
    expect(called).toBe(true)
    expect(res).toBe(10)
  })

  it('propagates errors when wrapped tool fails', async () => {
    const rawTool = defineTool({
      name: 'fail_tool',
      description: 'Fails',
      run: async () => {
        throw new Error('Tool computation exploded')
      },
    })

    const wrapped = traced(rawTool)
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((wrapped as any).run({})).rejects.toThrow('Tool computation exploded')
  })

  it('batch wraps an array of tools with traceTools', () => {
    const t1 = defineTool({ name: 't1', description: 't1', run: async () => 1 })
    const t2 = defineTool({ name: 't2', description: 't2', run: async () => 2 })
    const wrapped = traceTools([t1, t2])
    expect(wrapped.length).toBe(2)
    expect(isTraced(wrapped[0])).toBe(true)
    expect(isTraced(wrapped[1])).toBe(true)
  })
})
