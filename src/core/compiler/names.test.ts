import { describe, expect, test } from 'vitest'
import type { Program as AstProgram, Expr } from '../ast'
import { compileProgram } from './index'
import { compileSource, diagnosticsOf, spanOf } from './test-support'

const LET_HINT = "declare it with 'var' to make it mutable"
const E022_HINT = "globals can be declared once; use 'var' and assign instead"

describe('E020 undefined variable', () => {
  test('reports the identifier with a did-you-mean hint', () => {
    const source = 'let length = 1\nprint(lenght)'
    expect(diagnosticsOf(source)).toEqual([
      {
        code: 'E020',
        severity: 'error',
        message: "undefined variable 'lenght'",
        span: spanOf(source, 'lenght'),
        hint: "did you mean 'length'?",
      },
    ])
  })

  test('has no hint when nothing is close', () => {
    const source = 'print(zzzzz)'
    expect(diagnosticsOf(source)).toEqual([
      {
        code: 'E020',
        severity: 'error',
        message: "undefined variable 'zzzzz'",
        span: spanOf(source, 'zzzzz'),
      },
    ])
  })

  test('a distance must be smaller than the name length', () => {
    const [d] = diagnosticsOf('let y = 1\nprint(x)')
    expect(d?.hint).toBeUndefined()
  })

  test('ties prefer globals over builtins', () => {
    const [d] = diagnosticsOf('let pint = 1\nprnt(1)')
    expect(d?.hint).toBe("did you mean 'pint'?")
  })

  test('ties prefer the innermost local, then globals', () => {
    const source = 'let ad1 = 0\n{ let ab = 1; { let ac = 2; print(ad) } }'
    expect(diagnosticsOf(source)[0]?.hint).toBe("did you mean 'ac'?")
  })

  test('locals of enclosing functions are candidates', () => {
    const source = '{ let total = 1; let f = || totl }'
    expect(diagnosticsOf(source)[0]?.hint).toBe("did you mean 'total'?")
  })

  test('compiler-internal names are never suggested', () => {
    expect(diagnosticsOf('for x in [] { print(iter) }')[0]?.hint).toBe("did you mean 'str'?")
  })

  test('a local is not visible in its own initializer', () => {
    const source = '{ let abcd = abce }'
    expect(diagnosticsOf(source)).toEqual([
      expect.objectContaining({ code: 'E020', span: spanOf(source, 'abce') }),
    ])
    expect(diagnosticsOf(source)[0]?.hint).toBe("did you mean 'abs'?")
  })

  test('a local function cannot see a later local function', () => {
    const source = '{ fn even(n) { n == 0 or odd(n - 1) }; fn odd(n) { even(n) } }'
    expect(diagnosticsOf(source)).toEqual([
      expect.objectContaining({ code: 'E020', span: spanOf(source, 'odd') }),
    ])
  })

  test('applies to assignment targets', () => {
    const source = 'zz = 1'
    expect(diagnosticsOf(source)).toEqual([
      expect.objectContaining({ code: 'E020', message: "undefined variable 'zz'" }),
    ])
  })

  test('applies inside functions and to record shorthand', () => {
    const source = 'fn f() { {nope} }'
    expect(diagnosticsOf(source)).toEqual([
      expect.objectContaining({ code: 'E020', span: spanOf(source, 'nope') }),
    ])
  })
})

describe('E021 assignment to an immutable binding', () => {
  const cases: [string, string, string, string | undefined][] = [
    [
      'let',
      'let x = 1\nx = 2',
      "cannot assign to 'x' because it was declared with 'let'",
      LET_HINT,
    ],
    [
      'local let',
      '{ let x = 1; x += 2 }',
      "cannot assign to 'x' because it was declared with 'let'",
      LET_HINT,
    ],
    ['fn', 'fn x() { 1 }\nx = 2', "cannot assign to 'x' because it is a function", undefined],
    ['parameter', 'fn f(x) { x = 2 }', "cannot assign to 'x' because it is a parameter", undefined],
    [
      'pattern parameter',
      'fn f([x]) { x = 2 }',
      "cannot assign to 'x' because it is a parameter",
      undefined,
    ],
    [
      'loop variable',
      'for x in [] { x = 2 }',
      "cannot assign to 'x' because it is a loop variable",
      undefined,
    ],
    [
      'match binding',
      'match 1 { x => { x = 2 } }',
      "cannot assign to 'x' because it is a match binding",
      undefined,
    ],
    [
      'captured let',
      '{ let x = 1; let f = || { x = 2 } }',
      "cannot assign to 'x' because it was declared with 'let'",
      LET_HINT,
    ],
  ]
  test.each(cases)('%s', (_kind, source, message, hint) => {
    const at = source.lastIndexOf('x ')
    const anchor = { start: at, end: at + 1 }
    const expected = { code: 'E021', severity: 'error', message, span: anchor }
    expect(diagnosticsOf(source)).toEqual([hint === undefined ? expected : { ...expected, hint }])
  })

  test('builtins', () => {
    const source = 'print = 1'
    expect(diagnosticsOf(source)).toEqual([
      {
        code: 'E021',
        severity: 'error',
        message: "cannot assign to builtin 'print'",
        span: spanOf(source, 'print'),
      },
    ])
  })

  test('var bindings, captured vars and shadowing locals are assignable', () => {
    const source = 'var g = 1\ng = 2\n{ var v = 1; let f = || { v += 1 }; let print = 1 }'
    expect(diagnosticsOf(source)).toEqual([])
  })
})

describe('E022 duplicate global', () => {
  test('reports the binding name of the repeated declaration with the first line', () => {
    const source = 'let a = 1\n\nvar a = 2'
    expect(diagnosticsOf(source)).toEqual([
      {
        code: 'E022',
        severity: 'error',
        message: "'a' is already declared on line 1",
        span: { start: source.lastIndexOf('a'), end: source.lastIndexOf('a') + 1 },
        hint: E022_HINT,
      },
    ])
  })

  test('covers functions and destructuring patterns', () => {
    const source = 'fn f() { 1 }\nlet [x, f] = [1, 2]\nfn x() { 2 }'
    const fAt = spanOf(source, 'f]').start
    const xAt = spanOf(source, 'x()').start
    expect(diagnosticsOf(source).map((d) => [d.message, d.span])).toEqual([
      ["'f' is already declared on line 1", { start: fAt, end: fAt + 1 }],
      ["'x' is already declared on line 2", { start: xAt, end: xAt + 1 }],
    ])
  })

  test('the first declaration wins for later checks', () => {
    const source = 'let a = 1\nvar a = 2\na = 3'
    expect(diagnosticsOf(source).map((d) => d.code)).toEqual(['E022', 'E021'])
  })

  test('locals may repeat freely', () => {
    expect(diagnosticsOf('{ let a = 1; let a = 2 }\n{ let a = 3 }')).toEqual([])
  })
})

describe('E024 and E025', () => {
  test('break and continue outside a loop', () => {
    const source = 'break\n{ continue }'
    expect(diagnosticsOf(source)).toEqual([
      {
        code: 'E024',
        severity: 'error',
        message: "'break' can only be used inside a loop",
        span: spanOf(source, 'break'),
      },
      {
        code: 'E024',
        severity: 'error',
        message: "'continue' can only be used inside a loop",
        span: spanOf(source, 'continue'),
      },
    ])
  })

  test('a lambda inside a loop is outside the loop', () => {
    const source = 'while true { let f = || { break } }\nfor x in [] { fn g() { continue } }'
    expect(diagnosticsOf(source).map((d) => d.span)).toEqual([
      spanOf(source, 'break'),
      spanOf(source, 'continue'),
    ])
  })

  test('return at top level, including inside blocks and loops', () => {
    const source = 'return 1\nwhile true { return }'
    const message = "'return' can only be used inside a function"
    expect(diagnosticsOf(source)).toEqual([
      { code: 'E025', severity: 'error', message, span: spanOf(source, 'return') },
      { code: 'E025', severity: 'error', message, span: spanOf(source, 'return', 1) },
    ])
  })

  test('return inside functions and lambdas is fine', () => {
    expect(diagnosticsOf('fn f() { return 1 }\nlet g = || { return }')).toEqual([])
  })
})

describe('E026 use before declaration', () => {
  test('a top-level read before the declaration', () => {
    const source = 'print(x)\nlet x = 1'
    expect(diagnosticsOf(source)).toEqual([
      {
        code: 'E026',
        severity: 'error',
        message: "'x' is used before it is declared",
        span: spanOf(source, 'x'),
      },
    ])
  })

  test("'let max = max(3, 7)' hides the builtin", () => {
    const source = 'let max = max(3, 7)'
    expect(diagnosticsOf(source)).toEqual([
      {
        code: 'E026',
        severity: 'error',
        message: "'max' is used before it is declared",
        span: spanOf(source, 'max', 1),
        hint: "this declaration hides the builtin 'max'",
      },
    ])
  })

  test('assignment targets count', () => {
    const source = 'x = 1\nvar x = 0'
    expect(diagnosticsOf(source)).toEqual([
      expect.objectContaining({ code: 'E026', span: spanOf(source, 'x') }),
    ])
  })

  test('references in nested top-level blocks and loops count', () => {
    const source = '{ print(y) }\nfor i in [y] { }\nlet y = 1'
    expect(diagnosticsOf(source).map((d) => [d.code, d.span])).toEqual([
      ['E026', spanOf(source, 'y')],
      ['E026', spanOf(source, 'y', 1)],
    ])
  })

  test('references inside functions are late-bound', () => {
    const source = 'fn f() { g() + later }\nlet h = || later\nfn g() { 1 }\nlet later = 2'
    expect(diagnosticsOf(source)).toEqual([])
  })

  test('a global used after its declaration is fine', () => {
    expect(diagnosticsOf('let x = 1\nlet y = x\n{ let x = x }')).toEqual([])
  })
})

describe('reporting', () => {
  test('a syntax tree too deep for the JavaScript stack is E028, never a raw exception', () => {
    const at = { start: 0, end: 1 }
    let expr: Expr = { kind: 'Number', value: 1, span: at }
    for (let i = 0; i < 200_000; i++) expr = { kind: 'Unary', op: '-', operand: expr, span: at }
    const ast: AstProgram = {
      kind: 'Program',
      body: [{ kind: 'ExprStmt', expr, span: at }],
      span: at,
    }
    const output = compileProgram(ast, { source: '1', mode: 'main', firstProtoId: 0 })
    expect(output).toEqual({
      program: null,
      diagnostics: [expect.objectContaining({ code: 'E028', span: { start: 1, end: 1 } })],
    })
  })

  test('the deepest nesting the parser accepts compiles', () => {
    const source = `let v = ${'['.repeat(250)}1${']'.repeat(250)}`
    expect(diagnosticsOf(source)).toEqual([])
  })

  test('every name error is reported, sorted by position', () => {
    const source = 'fn f() { return 1 }\nbreak\nnope = 1\nlet q = 1\nq = 2\nreturn'
    expect(diagnosticsOf(source).map((d) => d.code)).toEqual(['E024', 'E020', 'E021', 'E025'])
  })

  test('the program is null when there are diagnostics', () => {
    expect(compileSource('nope').program).toBeNull()
  })
})
