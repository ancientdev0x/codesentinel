import { describe, expect, it, vi } from 'vitest'
import {
  langFor,
  nodeLineSpan,
  parseFile,
  to0BasedLine,
  to1BasedLine,
} from '../../../src/review/ast/parse'

describe('AST parse.ts', () => {
  describe('langFor', () => {
    it('detects python files', () => {
      expect(langFor('src/main.py')).toBe('python')
      expect(langFor('app/models.PY')).toBe('python')
    })

    it('detects typescript and tsx files', () => {
      expect(langFor('src/index.ts')).toBe('typescript')
      expect(langFor('src/util.mts')).toBe('typescript')
      expect(langFor('src/legacy.cts')).toBe('typescript')
      expect(langFor('src/components/App.tsx')).toBe('tsx')
    })

    it('detects javascript variants', () => {
      expect(langFor('bin/cli.js')).toBe('javascript')
      expect(langFor('src/view.jsx')).toBe('javascript')
      expect(langFor('dist/index.mjs')).toBe('javascript')
      expect(langFor('lib/loader.cjs')).toBe('javascript')
    })

    it('returns undefined for unsupported files', () => {
      expect(langFor('README.md')).toBeUndefined()
      expect(langFor('package.json')).toBeUndefined()
      expect(langFor('style.css')).toBeUndefined()
    })
  })

  describe('parseFile per language', () => {
    it('parses Python and returns a module root node', () => {
      const root = parseFile('python', 'def hello():\n    return "world"\n')
      expect(root).toBeDefined()
      expect(root?.kind()).toBe('module')
    })

    it('parses TypeScript and returns a program root node', () => {
      const root = parseFile(
        'typescript',
        'export interface User { id: string; name: string }\n'
      )
      expect(root).toBeDefined()
      expect(root?.kind()).toBe('program')
    })

    it('parses TSX and returns a program root node', () => {
      const root = parseFile(
        'tsx',
        'export const Button = () => <button>Click</button>\n'
      )
      expect(root).toBeDefined()
      expect(root?.kind()).toBe('program')
    })

    it('parses JavaScript and returns a program root node', () => {
      const root = parseFile('javascript', 'const add = (a, b) => a + b;\n')
      expect(root).toBeDefined()
      expect(root?.kind()).toBe('program')
    })

    it('returns undefined and logs warning on unhandled parse error without throwing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Force an unexpected error by passing an invalid language cast
      const result = parseFile('unknown' as never, 'invalid source')
      expect(result).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('AST parse failed'),
        expect.anything()
      )
      warnSpy.mockRestore()
    })
  })

  describe('line number conversions', () => {
    it('converts between 0-based and 1-based indexing', () => {
      expect(to1BasedLine(0)).toBe(1)
      expect(to1BasedLine(9)).toBe(10)
      expect(to0BasedLine(1)).toBe(0)
      expect(to0BasedLine(10)).toBe(9)
    })

    it('computes 1-based line span for a node', () => {
      const root = parseFile(
        'typescript',
        'function test() {\n  const x = 1\n  return x\n}\n'
      )
      expect(root).toBeDefined()
      const fn = root?.children()[0]
      expect(fn).toBeDefined()
      if (fn) {
        const span = nodeLineSpan(fn)
        expect(span.startLine).toBe(1)
        expect(span.endLine).toBe(4)
      }
    })
  })
})
