import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { startObservation } from '@langfuse/tracing'

export interface RunSpec {
  tool: string // 'bandit' | 'ruff' | 'tsc' | 'oxlint'
  cmd: string
  args: string[] // argv only, NEVER a shell string
  cwd: string // workspace (mounted read-only in docker mode)
  timeoutMs: number
  maxOutputBytes?: number // default 10 MiB
  okExitCodes?: number[] // bandit/ruff exit 1 = "findings", not failure
}

export type RunResult =
  | { status: 'ok'; exitCode: number; stdout: string; stderr: string; durationMs: number }
  | { status: 'timeout'; durationMs: number }
  | { status: 'unavailable'; reason: string } // ENOENT / image missing
  | { status: 'error'; exitCode: number | null; stderr: string; durationMs: number }

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024 // 10 MiB

/**
 * Minimal environment for sandboxed analyzers.
 * Strictly avoids leaking any secret tokens (e.g. GITHUB_TOKEN, API keys).
 */
export const MIN_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: tmpdir(),
  LANG: process.env.LANG ?? 'C.UTF-8',
}

/**
 * Executes a tool on the host with process-group isolation and strict timeouts.
 */
export const runHost = (spec: RunSpec): Promise<RunResult> => {
  return new Promise((resolve) => {
    const startTime = performance.now()
    const maxBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const okExitCodes = spec.okExitCodes ?? [0]

    let timedOut = false
    let timer: NodeJS.Timeout | undefined

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0

    let child: ReturnType<typeof spawn>

    try {
      child = spawn(spec.cmd, spec.args, {
        cwd: spec.cwd,
        env: MIN_ENV,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err: unknown) {
      const durationMs = Math.round(performance.now() - startTime)
      const error = err as NodeJS.ErrnoException
      if (error?.code === 'ENOENT') {
        return resolve({ status: 'unavailable', reason: error.message })
      }
      return resolve({
        status: 'error',
        exitCode: null,
        stderr: error?.message ?? String(err),
        durationMs,
      })
    }

    if (spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            try {
              child.kill('SIGKILL')
            } catch {
              // ignore
            }
          }
        }
      }, spec.timeoutMs)
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const str = chunk.toString('utf8')
      stdoutBytes += Buffer.byteLength(str)
      if (stdoutBytes <= maxBytes) {
        stdout += str
      }
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const str = chunk.toString('utf8')
      stderrBytes += Buffer.byteLength(str)
      if (stderrBytes <= maxBytes) {
        stderr += str
      }
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer)
      const durationMs = Math.round(performance.now() - startTime)
      if (err.code === 'ENOENT') {
        return resolve({ status: 'unavailable', reason: err.message })
      }
      if (timedOut) {
        return resolve({ status: 'timeout', durationMs })
      }
      return resolve({
        status: 'error',
        exitCode: null,
        stderr: err.message,
        durationMs,
      })
    })

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      const durationMs = Math.round(performance.now() - startTime)

      if (timedOut || signal === 'SIGKILL') {
        return resolve({ status: 'timeout', durationMs })
      }

      if (code !== null && okExitCodes.includes(code)) {
        return resolve({
          status: 'ok',
          exitCode: code,
          stdout,
          stderr,
          durationMs,
        })
      }

      return resolve({
        status: 'error',
        exitCode: code,
        stderr,
        durationMs,
      })
    })
  })
}

/**
 * Runs an analyzer command inside isolated sandbox (docker or host backend).
 * Emits a subprocess.<tool> tool observation span with duration, exit code, and timeout status.
 */
export const runIsolated = async (
  spec: RunSpec,
  backend: 'docker' | 'host'
): Promise<RunResult> => {
  const obs = startObservation(
    `subprocess.${spec.tool}`,
    {
      input: { cmd: spec.cmd, args: spec.args },
    },
    { asType: 'tool' }
  )

  let result: RunResult
  try {
    if (backend === 'docker') {
      const { runDocker } = await import('./docker')
      result = await runDocker(spec)
    } else {
      result = await runHost(spec)
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    obs.update({
      level: 'ERROR',
      statusMessage: errorMsg,
      metadata: { backend, status: 'error', timeoutMs: spec.timeoutMs },
    })
    obs.end()
    throw err
  }

  const durationMs = 'durationMs' in result ? result.durationMs : 0
  const exitCode = 'exitCode' in result ? result.exitCode : null
  const status = result.status

  const level =
    status === 'timeout' ? 'WARNING' : status === 'error' ? 'ERROR' : 'DEFAULT'

  obs.update({
    output: 'stdout' in result ? result.stdout.slice(0, 1000) : '',
    level,
    statusMessage:
      status === 'timeout'
        ? `Subprocess ${spec.tool} timed out after ${spec.timeoutMs}ms`
        : undefined,
    metadata: {
      backend,
      exitCode,
      status,
      timeoutMs: spec.timeoutMs,
      durationMs,
    },
  })
  obs.end()

  return result
}
