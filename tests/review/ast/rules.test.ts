import { describe, expect, it } from 'vitest'
import { parseFile } from '../../../src/review/ast/parse'
import {
  PYTHON_RULES,
  TYPESCRIPT_RULES,
  getRulesFor,
} from '../../../src/review/ast/rules/index'

describe('AST rule packs (rules.test.ts)', () => {
  describe('Rule pack resolution', () => {
    it('returns Python rules for python language', () => {
      const rules = getRulesFor('python')
      expect(rules).toBe(PYTHON_RULES)
      expect(rules).toHaveLength(7)
    })

    it('returns TypeScript rules for typescript, tsx, and javascript', () => {
      expect(getRulesFor('typescript')).toBe(TYPESCRIPT_RULES)
      expect(getRulesFor('tsx')).toBe(TYPESCRIPT_RULES)
      expect(getRulesFor('javascript')).toBe(TYPESCRIPT_RULES)
      expect(getRulesFor('typescript')).toHaveLength(5)
    })
  })

  describe('Python AST security rules', () => {
    const runPyRule = (ruleId: string, code: string) => {
      const ruleDef = PYTHON_RULES.find((r) => r.id === ruleId)
      if (!ruleDef) throw new Error(`Rule not found: ${ruleId}`)
      const root = parseFile('python', code)
      if (!root) throw new Error('Parse failed')
      return root.findAll({ rule: ruleDef.rule })
    }

    it('py-eval-exec: matches dynamic eval/exec, ignores string literals', () => {
      const positive = runPyRule('py-eval-exec', 'res = eval(user_input)\nexec(code_str)')
      expect(positive).toHaveLength(2)

      const negative = runPyRule('py-eval-exec', 'res = eval("1 + 1")\nexec("print(1)")')
      expect(negative).toHaveLength(0)
    })

    it('py-subprocess-shell: matches shell=True, ignores list commands', () => {
      const positive = runPyRule(
        'py-subprocess-shell',
        'subprocess.run(cmd, shell=True)\nsubprocess.Popen("ls", shell=True)'
      )
      expect(positive).toHaveLength(2)

      const negative = runPyRule(
        'py-subprocess-shell',
        'subprocess.run(["ls", "-l"])\nsubprocess.call(["cat", f])'
      )
      expect(negative).toHaveLength(0)
    })

    it('py-os-system: matches os.system, ignores safe os calls', () => {
      const positive = runPyRule('py-os-system', 'os.system(user_cmd)')
      expect(positive).toHaveLength(1)

      const negative = runPyRule(
        'py-os-system',
        'cwd = os.getcwd()\nos.path.join("a", "b")'
      )
      expect(negative).toHaveLength(0)
    })

    it('py-sql-concat: matches concatenated/formatted SQL, ignores parameterized', () => {
      const positive = runPyRule(
        'py-sql-concat',
        'cursor.execute("SELECT * FROM u WHERE id=" + uid)\ncursor.execute(f"SELECT * FROM u WHERE id={uid}")\ncursor.execute("SELECT * FROM u WHERE id=%s" % uid)'
      )
      expect(positive).toHaveLength(3)

      const negative = runPyRule(
        'py-sql-concat',
        'cursor.execute("SELECT * FROM u WHERE id=%s", (uid,))\ncursor.execute("SELECT 1")'
      )
      expect(negative).toHaveLength(0)
    })

    it('py-pickle-loads: matches pickle.loads, ignores pickle.dumps', () => {
      const positive = runPyRule('py-pickle-loads', 'obj = pickle.loads(raw_data)')
      expect(positive).toHaveLength(1)

      const negative = runPyRule('py-pickle-loads', 'data = pickle.dumps(obj)')
      expect(negative).toHaveLength(0)
    })

    it('py-yaml-unsafe: matches yaml.load without Loader, ignores safe load', () => {
      const positive = runPyRule('py-yaml-unsafe', 'config = yaml.load(stream)')
      expect(positive).toHaveLength(1)

      const negative = runPyRule(
        'py-yaml-unsafe',
        'config = yaml.load(stream, Loader=yaml.SafeLoader)\nsafe = yaml.safe_load(stream)'
      )
      expect(negative).toHaveLength(0)
    })

    it('py-requests-noverify: matches verify=False, ignores verify=True or default', () => {
      const positive = runPyRule(
        'py-requests-noverify',
        'requests.get("https://insecure.internal", verify=False)'
      )
      expect(positive).toHaveLength(1)

      const negative = runPyRule(
        'py-requests-noverify',
        'requests.get("https://example.com")\nrequests.post("https://example.com", verify=True)'
      )
      expect(negative).toHaveLength(0)
    })
  })

  describe('TypeScript AST security rules', () => {
    const runTsRule = (ruleId: string, code: string) => {
      const ruleDef = TYPESCRIPT_RULES.find((r) => r.id === ruleId)
      if (!ruleDef) throw new Error(`Rule not found: ${ruleId}`)
      const root = parseFile('typescript', code)
      if (!root) throw new Error('Parse failed')
      return root.findAll({ rule: ruleDef.rule })
    }

    it('ts-eval: matches eval and new Function, ignores regular functions', () => {
      const positive = runTsRule(
        'ts-eval',
        'eval(userCode)\nconst fn = new Function("x", userCode)'
      )
      expect(positive).toHaveLength(2)

      const negative = runTsRule(
        'ts-eval',
        'const fn = (x: string) => x\nfunction safe() { return 1 }'
      )
      expect(negative).toHaveLength(0)
    })

    it('ts-child-exec-template: matches template/concat exec, ignores string literals', () => {
      const positive = runTsRule(
        'ts-child-exec-template',
        'exec(`ls ${dir}`, cb)\nexecSync(`cat ${path}`)\nexec("cat " + file)'
      )
      expect(positive).toHaveLength(3)

      const negative = runTsRule(
        'ts-child-exec-template',
        'exec("ls -la", cb)\nexecSync("git status")'
      )
      expect(negative).toHaveLength(0)
    })

    it('ts-sql-template: matches template/concat SQL queries, ignores parameterized', () => {
      const positive = runTsRule(
        'ts-sql-template',
        'db.query(`SELECT * FROM users WHERE id = ${id}`)\ndb.query("SELECT * FROM users WHERE id = " + id)'
      )
      expect(positive).toHaveLength(2)

      const negative = runTsRule(
        'ts-sql-template',
        'db.query("SELECT * FROM users WHERE id = $1", [id])'
      )
      expect(negative).toHaveLength(0)
    })

    it('ts-innerhtml: matches dynamic innerHTML, ignores static string literals', () => {
      const positive = runTsRule(
        'ts-innerhtml',
        'container.innerHTML = payload\nelement.innerHTML = format(item)'
      )
      expect(positive).toHaveLength(2)

      const negative = runTsRule(
        'ts-innerhtml',
        'container.innerHTML = "<p>Static safe content</p>"'
      )
      expect(negative).toHaveLength(0)
    })

    it('ts-hardcoded-secret: matches hardcoded token/secret, ignores env vars', () => {
      const positive = runTsRule(
        'ts-hardcoded-secret',
        'const apiKey = "sk-live-123456789"\nconst userPassword = "SuperSecretPassword123!"'
      )
      expect(positive).toHaveLength(2)

      const negative = runTsRule(
        'ts-hardcoded-secret',
        'const apiKey = process.env.API_KEY\nconst username = "john_doe"\nconst token = config.token'
      )
      expect(negative).toHaveLength(0)
    })
  })
})
