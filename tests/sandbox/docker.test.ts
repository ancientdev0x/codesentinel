import { describe, expect, it } from 'vitest'
import {
  buildDockerArgs,
  isDockerAvailable,
  isDockerImageAvailable,
  runDocker,
  type DockerRunOptions,
} from '../../src/sandbox/docker'
import type { RunSpec } from '../../src/sandbox/run'

const dockerAvailable = (await isDockerAvailable()) && (await isDockerImageAvailable())

describe('Docker sandbox (E3.2)', () => {
  it('buildDockerArgs contains every required security isolation flag', () => {
    const spec: RunSpec = {
      tool: 'bandit',
      cmd: 'bandit',
      args: ['-f', 'json', '-r', 'app/'],
      cwd: '/workspace/test-repo',
      timeoutMs: 30000,
    }
    const opts: DockerRunOptions = {
      containerName: 'cs-bandit-fixedname',
      image: 'codesentinel-analyzers:0.1.0',
    }

    const args = buildDockerArgs(spec, opts)

    expect(args).toContain('run')
    expect(args).toContain('--rm')
    expect(args).toContain('--name')
    expect(args).toContain('cs-bandit-fixedname')
    expect(args).toContain('--network')
    expect(args).toContain('none')
    expect(args).toContain('--read-only')
    expect(args).toContain('--tmpfs')
    expect(args).toContain('/tmp:rw,size=64m')
    expect(args).toContain('--cap-drop')
    expect(args).toContain('ALL')
    expect(args).toContain('--security-opt')
    expect(args).toContain('no-new-privileges')
    expect(args).toContain('--pids-limit')
    expect(args).toContain('128')
    expect(args).toContain('--memory')
    expect(args).toContain('512m')
    expect(args).toContain('--cpus')
    expect(args).toContain('1')
    expect(args).toContain('--user')
    expect(args).toContain('10001')
    expect(args).toContain('-v')
    expect(args).toContain('/workspace/test-repo:/src:ro')
    expect(args).toContain('-w')
    expect(args).toContain('/src')
    expect(args).toContain('codesentinel-analyzers:0.1.0')

    // Snapshot verifies full argument order and integrity
    expect(args).toMatchSnapshot()
  })

  it.runIf(dockerAvailable)(
    'integration: network access is strictly blocked inside container',
    async () => {
      const result = await runDocker({
        tool: 'network-test',
        cmd: 'python',
        args: [
          '-c',
          "import socket; socket.create_connection(('1.1.1.1', 80), timeout=2)",
        ],
        cwd: process.cwd(),
        timeoutMs: 5000,
      })

      // Network request must fail inside container with --network none
      expect(result.status).toBe('error')
      if (result.status === 'error') {
        expect(result.stderr).toMatch(/(Network is unreachable|OSError|timeout)/i)
      }
    }
  )

  it.runIf(dockerAvailable)(
    'integration: long-running container is killed on timeout',
    async () => {
      const start = Date.now()
      const result = await runDocker({
        tool: 'sleep-test',
        cmd: 'sleep',
        args: ['30'],
        cwd: process.cwd(),
        timeoutMs: 300,
      })
      const elapsed = Date.now() - start

      expect(result.status).toBe('timeout')
      expect(elapsed).toBeLessThan(2000)
    }
  )
})
