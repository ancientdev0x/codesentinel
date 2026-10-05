import type { NapiConfig } from '@ast-grep/napi'
import type { Severity } from '../../findings'
import type { AstLang } from '../parse'

export interface AstRuleMetadata {
  cwe: string
}

export interface AstRule {
  id: string
  language: AstLang
  severity: Severity
  message: string
  rule: NapiConfig['rule']
  metadata: AstRuleMetadata
}

export const PYTHON_RULES: AstRule[] = [
  {
    id: 'py-eval-exec',
    language: 'python',
    severity: 'high',
    message: 'Use of eval/exec with dynamic arguments enables arbitrary code execution.',
    metadata: { cwe: 'CWE-95' },
    rule: {
      any: [
        {
          all: [
            { pattern: 'eval($X)' },
            { not: { has: { kind: 'string', stopBy: 'end' } } },
          ],
        },
        {
          all: [
            { pattern: 'exec($X)' },
            { not: { has: { kind: 'string', stopBy: 'end' } } },
          ],
        },
      ],
    },
  },
  {
    id: 'py-subprocess-shell',
    language: 'python',
    severity: 'high',
    message: 'Subprocess invoked with shell=True is vulnerable to shell injection.',
    metadata: { cwe: 'CWE-78' },
    rule: {
      all: [
        { pattern: 'subprocess.$F($$$ARGS)' },
        {
          has: {
            kind: 'keyword_argument',
            regex: '^shell\\s*=\\s*True',
            stopBy: 'end',
          },
        },
      ],
    },
  },
  {
    id: 'py-os-system',
    language: 'python',
    severity: 'high',
    message: 'os.system executes shell commands without argument sanitization.',
    metadata: { cwe: 'CWE-78' },
    rule: {
      pattern: 'os.system($X)',
    },
  },
  {
    id: 'py-sql-concat',
    language: 'python',
    severity: 'high',
    message:
      'SQL query constructed via string concatenation, % formatting, or f-string. Use parameterized queries.',
    metadata: { cwe: 'CWE-89' },
    rule: {
      all: [
        { pattern: '$C.execute($$$ARGS)' },
        {
          has: {
            any: [
              { kind: 'binary_operator', regex: '\\+' },
              { kind: 'binary_operator', regex: '%' },
              { kind: 'interpolation' },
            ],
            stopBy: 'end',
          },
        },
      ],
    },
  },
  {
    id: 'py-pickle-loads',
    language: 'python',
    severity: 'high',
    message: 'Unpickling untrusted data with pickle.loads can execute arbitrary code.',
    metadata: { cwe: 'CWE-502' },
    rule: {
      pattern: 'pickle.loads($X)',
    },
  },
  {
    id: 'py-yaml-unsafe',
    language: 'python',
    severity: 'high',
    message: 'yaml.load without explicit Loader=SafeLoader can execute arbitrary code.',
    metadata: { cwe: 'CWE-502' },
    rule: {
      all: [
        { pattern: 'yaml.load($$$ARGS)' },
        {
          not: {
            has: {
              kind: 'keyword_argument',
              regex: 'Loader',
              stopBy: 'end',
            },
          },
        },
      ],
    },
  },
  {
    id: 'py-requests-noverify',
    language: 'python',
    severity: 'medium',
    message: 'TLS certificate verification is disabled (verify=False) in requests call.',
    metadata: { cwe: 'CWE-295' },
    rule: {
      all: [
        { pattern: 'requests.$M($$$ARGS)' },
        {
          has: {
            kind: 'keyword_argument',
            regex: '^verify\\s*=\\s*False',
            stopBy: 'end',
          },
        },
      ],
    },
  },
]

export const TYPESCRIPT_RULES: AstRule[] = [
  {
    id: 'ts-eval',
    language: 'typescript',
    severity: 'high',
    message: 'Use of eval or new Function allows arbitrary dynamic code execution.',
    metadata: { cwe: 'CWE-95' },
    rule: {
      any: [{ pattern: 'eval($X)' }, { pattern: 'new Function($$$ARGS)' }],
    },
  },
  {
    id: 'ts-child-exec-template',
    language: 'typescript',
    severity: 'high',
    message:
      'Command execution via exec or execSync with template interpolation or concatenation is vulnerable to command injection.',
    metadata: { cwe: 'CWE-78' },
    rule: {
      all: [
        {
          any: [{ pattern: 'exec($$$ARGS)' }, { pattern: 'execSync($$$ARGS)' }],
        },
        {
          has: {
            any: [
              { kind: 'template_substitution' },
              { kind: 'binary_expression', regex: '\\+' },
            ],
            stopBy: 'end',
          },
        },
      ],
    },
  },
  {
    id: 'ts-sql-template',
    language: 'typescript',
    severity: 'high',
    message:
      'SQL query constructed via template string or concatenation. Use parameterized queries.',
    metadata: { cwe: 'CWE-89' },
    rule: {
      all: [
        { pattern: '$DB.query($$$ARGS)' },
        {
          has: {
            any: [
              { kind: 'template_substitution' },
              { kind: 'binary_expression', regex: '\\+' },
            ],
            stopBy: 'end',
          },
        },
      ],
    },
  },
  {
    id: 'ts-innerhtml',
    language: 'typescript',
    severity: 'high',
    message:
      'Assigning dynamic non-literal content to innerHTML enables Cross-Site Scripting (XSS).',
    metadata: { cwe: 'CWE-79' },
    rule: {
      all: [
        { pattern: '$E.innerHTML = $X' },
        { not: { has: { kind: 'string', stopBy: 'end' } } },
      ],
    },
  },
  {
    id: 'ts-hardcoded-secret',
    language: 'typescript',
    severity: 'medium',
    message: 'Potential hardcoded secret or credential assigned to variable.',
    metadata: { cwe: 'CWE-798' },
    rule: {
      all: [
        { kind: 'variable_declarator' },
        {
          has: {
            field: 'name',
            regex: '(?i)(secret|token|password|api_?key)',
            stopBy: 'end',
          },
        },
        {
          has: {
            field: 'value',
            kind: 'string',
            stopBy: 'end',
          },
        },
      ],
    },
  },
]

export const getRulesFor = (lang: AstLang): AstRule[] => {
  if (lang === 'python') return PYTHON_RULES
  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    return TYPESCRIPT_RULES
  }
  return []
}
