import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeRepo } from '../tests/helpers/makeRepo.ts'

// Only read the three approved Langfuse vars from .env
const envContent = await fs.readFile(path.join(process.cwd(), '.env'), 'utf8')
let langfusePublicKey = ''
let langfuseSecretKey = ''
let langfuseBaseUrl = 'https://jp.cloud.langfuse.com'

for (const line of envContent.split('\n')) {
  const m = line.match(
    /^(LANGFUSE_PUBLIC_KEY|LANGFUSE_SECRET_KEY|LANGFUSE_BASE_URL)=(.*)$/
  )
  if (m) {
    const val = m[2].trim().replace(/^['"]|['"]$/g, '')
    if (m[1] === 'LANGFUSE_PUBLIC_KEY') langfusePublicKey = val
    if (m[1] === 'LANGFUSE_SECRET_KEY') langfuseSecretKey = val
    if (m[1] === 'LANGFUSE_BASE_URL') langfuseBaseUrl = val
  }
}

if (!langfusePublicKey || !langfuseSecretKey) {
  throw new Error('LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is missing from .env')
}

const argTraceIdIdx = process.argv.indexOf('--traceId')
const passedTraceId = argTraceIdIdx !== -1 ? process.argv[argTraceIdIdx + 1] : undefined

console.log('[CodeSentinel:LangfuseProof] Initializing test repo...')
const repo = await makeRepo()

try {
  let traceId = passedTraceId ?? ''
  if (!traceId) {
    const payload = JSON.stringify({
      platform: 'local',
      workspace: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
    })

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      LANGFUSE_PUBLIC_KEY: langfusePublicKey,
      LANGFUSE_SECRET_KEY: langfuseSecretKey,
      LANGFUSE_BASE_URL: langfuseBaseUrl,
      CodeSentinel_MODEL: 'openai-codex/gpt-5.6-luna',
      CodeSentinel_THINKING_LEVEL: 'medium',
      CodeSentinel_DEBUG_LLM: '1',
    }

    console.log('[CodeSentinel:LangfuseProof] Running review via flue...')
    let traceId = ''
    let fullStdout = ''
    let fullStderr = ''

    const child = spawn(
      'npx',
      ['flue', 'run', 'review', '--target', 'node', '--input', payload],
      {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )

    const checkTraceId = (str: string) => {
      const m = str.match(/\[CodeSentinel:Langfuse\] Trace ID:\s*([0-9a-fA-F]{32})/)
      if (m && !traceId) {
        traceId = m[1]
        console.log(
          `\n>>> [CodeSentinel:LangfuseProof] Captured Trace ID: ${traceId} <<<\n`
        )
      }
    }

    child.stdout.on('data', (d) => {
      const str = d.toString()
      fullStdout += str
      process.stdout.write(str)
      checkTraceId(str)
    })

    child.stderr.on('data', (d) => {
      const str = d.toString()
      fullStderr += str
      process.stderr.write(str)
      checkTraceId(str)
    })

    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve()
        else
          reject(
            new Error(`flue run review exited with code ${code}\nStderr: ${fullStderr}`)
          )
      })
    })

    if (!traceId) {
      checkTraceId(fullStdout + '\n' + fullStderr)
    }

    if (!traceId) {
      throw new Error('Failed to capture Langfuse Trace ID from review run output')
    }

    console.log(
      `\n[CodeSentinel:LangfuseProof] Waiting 5s for Langfuse cloud ingestion...`
    )
    await new Promise((res) => setTimeout(res, 5000))
  }

  // Query Langfuse v2 public API
  const auth = Buffer.from(`${langfusePublicKey}:${langfuseSecretKey}`).toString('base64')
  const apiUrl = `${langfuseBaseUrl}/api/public/v2/observations?traceId=${traceId}&limit=100`

  console.log(`[CodeSentinel:LangfuseProof] Fetching observations from: ${apiUrl}`)
  let obsResponse: any = null
  let attempts = 0
  while (attempts < 5) {
    attempts++
    const res = await fetch(apiUrl, {
      headers: { Authorization: `Basic ${auth}` },
    })

    if (!res.ok) {
      throw new Error(`Langfuse API returned status ${res.status}: ${await res.text()}`)
    }

    obsResponse = await res.json()
    if (obsResponse.data && obsResponse.data.length > 0) {
      break
    }
    console.log(
      `[CodeSentinel:LangfuseProof] No observations yet (attempt ${attempts}/5). Retrying in 3s...`
    )
    await new Promise((r) => setTimeout(r, 3000))
  }

  if (!obsResponse?.data || obsResponse.data.length === 0) {
    throw new Error(`No observations found for traceId: ${traceId}`)
  }

  console.log(
    `[CodeSentinel:LangfuseProof] Retrieved ${obsResponse.data.length} observations!`
  )

  // Assert node spans
  const names = obsResponse.data.map((o: any) => o.name)
  console.log('[CodeSentinel:LangfuseProof] Observation names:', names)

  const nodeSpans = names.filter((n: string) => n.startsWith('node.'))
  console.log('[CodeSentinel:LangfuseProof] Node spans found:', nodeSpans)

  const hasGenerations = obsResponse.data.some(
    (o: any) => o.type === 'GENERATION' || o.name === 'llm'
  )
  console.log(
    '[CodeSentinel:LangfuseProof] Generation observation found:',
    hasGenerations
  )

  if (nodeSpans.length === 0) {
    throw new Error('No node.* spans found in Langfuse observations')
  }
  if (!hasGenerations) {
    throw new Error('No generation observation (llm) found in Langfuse observations')
  }

  // Scrub paths to keep repo-relative or <tmp>
  const scrubbedJson = JSON.stringify(obsResponse, null, 2)
    .replace(new RegExp(repo.dir, 'g'), '<tmp>/repo')
    .replace(new RegExp(process.cwd(), 'g'), '.')

  const outputPath = path.join(process.cwd(), 'eval-results', 'langfuse-trace.json')
  await fs.writeFile(outputPath, scrubbedJson)
  console.log(
    `\n[CodeSentinel:LangfuseProof] SUCCESS! Trace evidence saved to ${outputPath}`
  )
  console.log(
    `[CodeSentinel:LangfuseProof] Trace URL: ${langfuseBaseUrl}/project/trace/${traceId}`
  )
} finally {
  await repo.cleanup()
}
