import { describe, expect, test } from 'vitest'
import type { FnDecl } from './ast'
import { printAst } from './ast-print'
import { parse } from './parser'

function printed(source: string): string[] {
  const result = parse(source)
  expect(result.diagnostics).toEqual([])
  return result.program.body.map((stmt) => printAst(stmt))
}

function firstError(source: string): { code: string; message: string; start: number } {
  const [first] = parse(source).diagnostics
  expect(first).toBeDefined()
  return { code: first!.code, message: first!.message, start: first!.span.start }
}

describe('parse: function contracts (SPEC §3.1, §7.16)', () => {
  test('requires and ensures clauses print before the body in source order', () => {
    // Arrange
    const source = 'fn f(x) requires x > 0 ensures result < x requires x < 10 { x - 1 }'

    // Act / Assert
    expect(printed(source)).toEqual([
      '(fn f (x) (requires (> x 0)) (ensures (< result x)) (requires (< x 10)) (block (- x 1)))',
    ])
  })

  test('clauses may sit on their own lines between the parameters and the body', () => {
    // Arrange
    const source = `fn average(xs)
  requires len(xs) > 0
  ensures result >= 0
{
  sum(xs) / len(xs)
}`

    // Act / Assert
    expect(printed(source)).toEqual([
      '(fn average (xs) (requires (> (call len xs) 0)) (ensures (>= result 0)) (block (/ (call sum xs) (call len xs))))',
    ])
  })

  test('a clause records its keyword span and covers the keyword through the expression', () => {
    // Arrange
    const source = 'fn f(x) requires x > 0 { x }'

    // Act
    const decl = parse(source).program.body[0] as FnDecl
    const [clause] = decl.fn.contracts

    // Assert
    expect(clause).toMatchObject({
      kind: 'Contract',
      clause: 'requires',
      keywordSpan: { start: 8, end: 16 },
      span: { start: 8, end: 22 },
    })
  })

  test('a function without contracts has an empty clause list, and so does a lambda', () => {
    // Arrange / Act
    const decl = parse('fn f(x) { x }').program.body[0] as FnDecl
    const lambda = parse('let g = |x| x').program.body[0]!

    // Assert
    expect(decl.fn.contracts).toEqual([])
    expect(lambda).toMatchObject({ init: { kind: 'Function', contracts: [] } })
  })

  test('anonymous fn expressions take contracts too', () => {
    // Arrange / Act / Assert
    expect(printed('let g = fn(n) requires n >= 0 { n }')).toEqual([
      '(let g (fn (n) (requires (>= n 0)) (block n)))',
    ])
  })

  test('requires and ensures stay ordinary identifiers everywhere else', () => {
    // Arrange
    const source = `let requires = 1
var ensures = requires + 1
let result = ensures
fn requires_two(requires) { requires }`

    // Act / Assert
    expect(printed(source)).toEqual([
      '(let requires 1)',
      '(var ensures (+ requires 1))',
      '(let result ensures)',
      '(fn requires_two (requires) (block requires))',
    ])
  })

  test('a clause may name a variable called requires', () => {
    // Arrange / Act / Assert
    expect(printed('fn f(requires) requires requires > 0 { requires }')).toEqual([
      '(fn f (requires) (requires (> requires 0)) (block requires))',
    ])
  })

  test('a `{` at the start of a clause is a record literal; after an operand it is the body', () => {
    // Arrange / Act / Assert
    expect(printed('fn f(x) requires {a: x}.a == x { x }')).toEqual([
      '(fn f (x) (requires (== (. (record a:x) a) x)) (block x))',
    ])
  })

  test('inside a block, a clause expression stops before an operator that starts a new line', () => {
    // Arrange
    const source = `fn f(x)
  requires x
    > 0
{ x }`

    // Act / Assert
    expect(firstError(source)).toEqual({
      code: 'E010',
      message: "expected '{' but found '>'",
      start: source.indexOf('>'),
    })
  })

  test('an operator at the end of a line continues the clause expression', () => {
    // Arrange
    const source = `fn f(x)
  requires x > 0 and
    x < 10
{ x }`

    // Act / Assert
    expect(printed(source)).toEqual(['(fn f (x) (requires (and (> x 0) (< x 10))) (block x))'])
  })

  test('a clause without an expression is a syntax error', () => {
    // Arrange / Act / Assert
    expect(firstError('fn f(x) requires { x }').code).toBe('E010')
    expect(firstError('fn f(x) ensures').message).toBe(
      'expected an expression but found end of file',
    )
  })

  test('another word after the parameters still asks for the body', () => {
    // Arrange / Act / Assert
    expect(firstError('fn f(x) require x > 0 { x }')).toEqual({
      code: 'E010',
      message: "expected '{' but found identifier 'require'",
      start: 8,
    })
  })

  test('clause expressions are checked after parsing like any expression', () => {
    // Arrange / Act
    const result = parse('fn f(x) requires 0 < x < 10 { x }')

    // Assert
    expect(result.diagnostics.map((d) => d.code)).toEqual(['E013'])
  })
})
