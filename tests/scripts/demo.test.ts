import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runDemo } from '../../scripts/demo'

const execFileAsync = promisify(execFile)

describe('npm run demo (4.1)', () => {
  it('runs programmatically and detects seeded issues in under 1 minute', async () => {
    const start = Date.now()
    const result = await runDemo({ quiet: true })
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(60000)
    expect(result.files).toContain('app/db.py')
    expect(result.files).toContain('web/config.ts')
    expect(result.files).toContain('app/clean.py')

    const dbFinding = result.findings.find((f) => f.file === 'app/db.py')
    expect(dbFinding).toBeDefined()
    expect(dbFinding?.cwe).toBe('CWE-89')

    const secretFinding = result.findings.find((f) => f.file === 'web/config.ts')
    expect(secretFinding).toBeDefined()
    expect(secretFinding?.cwe).toBe('CWE-798')

    const cleanFindings = result.findings.filter((f) => f.file === 'app/clean.py')
    expect(cleanFindings).toHaveLength(0)
  })

  it('runs via CLI and exits 0 with formatted output', async () => {
    const env = { ...process.env, CodeSentinel_SANDBOX: 'host' }
    delete env.VITEST

    const { stdout } = await execFileAsync('npx', ['vite-node', 'scripts/demo.ts'], {
      cwd: process.cwd(),
      env,
      timeout: 30000,
    })

    expect(stdout).toContain('CodeSentinel Demo Review')
    expect(stdout).toContain('app/db.py')
    expect(stdout).toContain('web/config.ts')
    expect(stdout).toContain('app/clean.py')
    expect(stdout).toContain('CLEAN')
    expect(stdout).toContain('exit code 0')
  })
})
