import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import type { RunResult, RunSpec } from './run'

const execFileAsync = promisify(execFile)

export const DOCKER_IMAGE = 'codesentinel-analyzers:0.1.0'
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024 // 10 MiB

export interface DockerRunOptions {
  image?: string
  containerName?: string
}

/**
 * Builds the strict sandboxed container arguments for `docker run`.
 */
export const buildDockerArgs = (spec: RunSpec, opts?: DockerRunOptions): string[] => {
  const image = opts?.image ?? DOCKER_IMAGE
  const rand = randomBytes(4).toString('hex')
  const containerName = opts?.containerName ?? `cs-${spec.tool}-${rand}`

  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--user',
    '10001',
    '-v',
    `${spec.cwd}:/src:ro`,
    '-w',
    '/src',
    image,
    spec.cmd,
    ...spec.args,
  ]
}

/**
 * Checks if Docker daemon is responsive.
 */
export const isDockerAvailable = async (): Promise<boolean> => {
  try {
    await execFileAsync('docker', ['info'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * Checks if the analyzer image exists or attempts to build it if missing.
 */
export const ensureDockerImage = async (
  image: string = DOCKER_IMAGE,
  timeoutMs = 180_000
): Promise<boolean> => {
  try {
    await execFileAsync('docker', ['image', 'inspect', image], { timeout: 5000 })
    return true
  } catch {
    // Try building image if inspect fails
    try {
      await execFileAsync(
        'docker',
        ['build', '-t', image, '-f', 'docker/analyzers.Dockerfile', 'docker'],
        { timeout: timeoutMs }
      )
      return true
    } catch {
      return false
    }
  }
}

let loggedBackend = false

/**
 * Selects between 'docker' and 'host' backends based on preference and environment.
 */
export const resolveSandboxBackend = async (
  preferred: 'auto' | 'docker' | 'host' = 'auto'
): Promise<'docker' | 'host'> => {
  let backend: 'docker' | 'host' = 'host'

  if (preferred === 'host') {
    backend = 'host'
  } else if (preferred === 'docker') {
    backend = 'docker'
  } else {
    // auto mode
    const dockerOk = await isDockerAvailable()
    if (dockerOk) {
      const imageOk = await ensureDockerImage(DOCKER_IMAGE)
      backend = imageOk ? 'docker' : 'host'
    } else {
      backend = 'host'
    }
  }

  if (!loggedBackend) {
    console.log(`[CodeSentinel] Sandboxed analyzers backend: ${backend}`)
    loggedBackend = true
  }

  return backend
}

/**
 * Executes a tool inside an isolated Docker container with wall-clock timeout.
 */
export const runDocker = (spec: RunSpec, opts?: DockerRunOptions): Promise<RunResult> => {
  return new Promise((resolve) => {
    const startTime = performance.now()
    const maxBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const okExitCodes = spec.okExitCodes ?? [0]

    const rand = randomBytes(4).toString('hex')
    const containerName = opts?.containerName ?? `cs-${spec.tool}-${rand}`
    const dockerArgs = buildDockerArgs(spec, { ...opts, containerName })

    let timedOut = false
    let timer: NodeJS.Timeout | undefined

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0

    let child: ReturnType<typeof spawn>

    try {
      child = spawn('docker', dockerArgs, {
        cwd: spec.cwd,
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
      timer = setTimeout(async () => {
        timedOut = true
        // On timeout, kill container via `docker kill` in addition to CLI process
        try {
          await execFileAsync('docker', ['kill', containerName], { timeout: 3000 }).catch(
            () => {}
          )
        } catch {
          // ignore
        }
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
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
        return resolve({ status: 'unavailable', reason: 'docker CLI not found' })
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

      // Check if container failed because image is missing
      if (
        stderr.includes('Unable to find image') ||
        stderr.includes('pull access denied')
      ) {
        return resolve({
          status: 'unavailable',
          reason: `Docker image not available: ${opts?.image ?? DOCKER_IMAGE}`,
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
