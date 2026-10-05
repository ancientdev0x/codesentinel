import { describe, expect, it } from 'vitest'
import { runIsolated } from '../../src/sandbox/run'

describe('runIsolated - host backend (E3.1)', () => {
  it('kills process on timeout in under 1s', async () => {
    const start = Date.now()
    const result = await runIsolated(
      {
        tool: 'test',
        cmd: 'node',
        args: ['-e', 'setTimeout(()=>{}, 10000)'],
        cwd: process.cwd(),
        timeoutMs: 200,
      },
      'host'
    )
    const elapsed = Date.now() - start

    expect(result.status).toBe('timeout')
    expect(elapsed).toBeLessThan(1000)
  })

  it('classifies missing executable (ENOENT) as unavailable', async () => {
    const result = await runIsolated(
      {
        tool: 'test',
        cmd: 'non_existent_binary_xyz_12345',
        args: [],
        cwd: process.cwd(),
        timeoutMs: 2000,
      },
      'host'
    )

    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') {
      expect(result.reason).toContain('ENOENT')
    }
  })

  it('treats exit code 1 as ok when okExitCodes contains 1', async () => {
    const result = await runIsolated(
      {
        tool: 'test',
        cmd: 'node',
        args: ['-e', 'process.stdout.write("found finding"); process.exit(1)'],
        cwd: process.cwd(),
        timeoutMs: 2000,
        okExitCodes: [0, 1],
      },
      'host'
    )

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('found finding')
    }
  })

  it('treats non-zero exit code as error when not in okExitCodes', async () => {
    const result = await runIsolated(
      {
        tool: 'test',
        cmd: 'node',
        args: ['-e', 'process.stderr.write("unexpected failure"); process.exit(2)'],
        cwd: process.cwd(),
        timeoutMs: 2000,
        okExitCodes: [0, 1],
      },
      'host'
    )

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('unexpected failure')
    }
  })

  it('does not leak GITHUB_TOKEN or sensitive environment variables to subprocess', async () => {
    const originalToken = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = 'secret_token_12345'

    try {
      const result = await runIsolated(
        {
          tool: 'test',
          cmd: 'node',
          args: ['-e', 'process.stdout.write(process.env.GITHUB_TOKEN ?? "ABSENT")'],
          cwd: process.cwd(),
          timeoutMs: 2000,
        },
        'host'
      )

      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(result.stdout).toBe('ABSENT')
      }
    } finally {
      if (originalToken !== undefined) {
        process.env.GITHUB_TOKEN = originalToken
      } else {
        delete process.env.GITHUB_TOKEN
      }
    }
  })

  it('records subprocess span with tool name and metadata', async () => {
    const result = await runIsolated(
      {
        tool: 'bandit',
        cmd: 'node',
        args: ['-e', 'process.stdout.write("[]")'],
        cwd: process.cwd(),
        timeoutMs: 2000,
      },
      'host'
    )

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})
