import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRepo, type TestRepo } from '../../helpers/makeRepo'
import { runAstChecks } from '../../../src/review/ast/checks'
import { getChangedFiles, type ReviewFileWithDiff } from '../../../src/review/diff'
import type { ReviewConfig } from '../../../src/review/config'

describe('runAstChecks (E2.4)', () => {
  let repo: TestRepo
  let changedFiles: ReviewFileWithDiff[]

  beforeAll(async () => {
    repo = await makeRepo()
    const cfg: ReviewConfig = {
      platform: 'local',
      workspace: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      model: 'test-model',
      thinkingLevel: 'medium',
      reviewLanguage: 'English',
      telemetry: false,
      mcpServers: {},
    }
    const result = await getChangedFiles(cfg)
    changedFiles = result.files
  })

  afterAll(async () => {
    if (repo) {
      await repo.cleanup()
    }
  })

  it('finds expected security vulnerabilities on the fixture repository', () => {
    const findings = runAstChecks(changedFiles)

    // Expected rule IDs
    const ruleIds = findings.map((f) => f.ruleId)
    expect(ruleIds).toContain('py-subprocess-shell')
    expect(ruleIds).toContain('py-sql-concat')
    expect(ruleIds).toContain('py-eval-exec')
    expect(ruleIds).toContain('ts-child-exec-template')
    expect(ruleIds).toContain('ts-eval')

    // Verify properties of findings
    const pySubprocess = findings.find((f) => f.ruleId === 'py-subprocess-shell')
    expect(pySubprocess).toBeDefined()
    expect(pySubprocess?.source).toBe('ast-grep')
    expect(pySubprocess?.status).toBe('candidate')
    expect(pySubprocess?.cwe).toBe('CWE-78')
    expect(pySubprocess?.symbol).toBe('run_ping')

    const pySql = findings.find((f) => f.ruleId === 'py-sql-concat')
    expect(pySql).toBeDefined()
    expect(pySql?.cwe).toBe('CWE-89')
    expect(pySql?.symbol).toBe('get_user')

    const pyEval = findings.find((f) => f.ruleId === 'py-eval-exec')
    expect(pyEval).toBeDefined()
    expect(pyEval?.cwe).toBe('CWE-95')
    expect(pyEval?.symbol).toBe('evaluate')

    const tsExec = findings.find((f) => f.ruleId === 'ts-child-exec-template')
    expect(tsExec).toBeDefined()
    expect(tsExec?.cwe).toBe('CWE-78')
    expect(tsExec?.symbol).toBe('listDir')

    const tsEval = findings.find((f) => f.ruleId === 'ts-eval')
    expect(tsEval).toBeDefined()
    expect(tsEval?.cwe).toBe('CWE-95')
    expect(tsEval?.symbol).toBe('runCode')
  })

  it('produces zero findings in clean files', () => {
    const findings = runAstChecks(changedFiles)

    const cleanFindings = findings.filter(
      (f) =>
        f.file.endsWith('clean_math.py') ||
        f.file.endsWith('clean_utils.py') ||
        f.file.endsWith('clean_format.ts') ||
        f.file.endsWith('clean_sanitize.ts')
    )

    expect(cleanFindings).toHaveLength(0)
  })

  it('filters out matches that do not intersect changedLines', () => {
    const fileWithUnchangedVuln: ReviewFileWithDiff = {
      fileName: 'test.py',
      fileContent: [
        'def safe_func():',
        '    return 42',
        '',
        'def unsafe_func():',
        '    eval(user_input)',
      ].join('\n'),
      changedLines: [{ start: 1, end: 2 }], // Only safe_func was changed
      diff: '@@ -1,2 +1,2 @@\n+def safe_func():\n+    return 42',
    }

    const findings = runAstChecks([fileWithUnchangedVuln])
    expect(findings).toHaveLength(0)
  })

  it('includes matches that intersect changedLines', () => {
    const fileWithChangedVuln: ReviewFileWithDiff = {
      fileName: 'test.py',
      fileContent: [
        'def safe_func():',
        '    return 42',
        '',
        'def unsafe_func():',
        '    eval(user_input)',
      ].join('\n'),
      changedLines: [{ start: 4, end: 5 }], // unsafe_func was changed
      diff: '@@ -4,2 +4,2 @@\n+def unsafe_func():\n+    eval(user_input)',
    }

    const findings = runAstChecks([fileWithChangedVuln])
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('py-eval-exec')
    expect(findings[0].symbol).toBe('unsafe_func')
  })
})
