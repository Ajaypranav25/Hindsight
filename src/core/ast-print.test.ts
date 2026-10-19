import { describe, expect, test } from 'vitest'
import type { Expr, Pattern } from './ast'
import type { Span } from './span'
import { printAst } from './ast-print'
import { parse } from './parser'

const at: Span = { start: 0, end: 0 }

function printed(source: string): string {
  const result = parse(source)
  expect(result.diagnostics).toEqual([])
  return printAst(result.program)
}

describe('printAst: statements', () => {
  test.each([
    ['', '(program)'],
    ['a; b', '(program a b)'],
    ['let [a, b] = c', '(program (let [a b] c))'],
    ['var x = 1', '(program (var x 1))'],
    ['fn f(a) { a }', '(program (fn f (a) (block a)))'],
    ['x += 1', '(program (+= x 1))'],
    ['fn f() { return }', '(program (fn f () (block (return))))'],
    ['fn f() { return 1 }', '(program (fn f () (block (return 1))))'],
    ['while a { break; continue }', '(program (while a (block (break) (continue))))'],
    ['for x in xs { }', '(program (for x xs (block)))'],
    ['{ }', '(program (block))'],
  ])('%j', (source, expected) => {
    expect(printed(source)).toBe(expected)
  })
})

describe('printAst: expressions', () => {
  test.each([
    ['1.5', '1.5'],
    ['"a\\"b\\n"', '"a\\"b\\n"'],
    ['"x {y} z"', '(template "x " y " z")'],
    ['true', 'true'],
    ['nil', 'nil'],
    ['[1, ...xs]', '(list 1 (... xs))'],
    ['({a, b: 1, "c d": 2, "if": 3, ...r})', '(record a b:1 "c d":2 "if":3 (... r))'],
    ['-a', '(- a)'],
    ['not a', '(not a)'],
    ['a + b', '(+ a b)'],
    ['a and b', '(and a b)'],
    ['f(a)', '(call f a)'],
    ['a |> f(b)', '(pipe f a b)'],
    ['a[0]', '(index a 0)'],
    ['a.b', '(. a b)'],
    ['fn(a) { a }', '(fn (a) (block a))'],
    ['|a, b| a', '(lambda (a b) a)'],
    ['if a { b }', '(if a (block b))'],
    ['if a { b } else { c }', '(if a (block b) (block c))'],
    ['match a { x if x => 1, _ => { 2 } }', '(match a (arm x (if x) 1) (arm _ (block 2)))'],
  ])('%j', (source, expected) => {
    expect(printed(source)).toBe(`(program ${expected})`)
  })

  test('negative zero and non-finite numbers print distinctly', () => {
    // Arrange
    const numbers: Expr[] = [-0, NaN, Infinity].map((value) => ({
      kind: 'Number',
      value,
      span: at,
    }))

    // Act / Assert
    expect(numbers.map((n) => printAst(n))).toEqual(['-0', 'NaN', 'Infinity'])
  })
})

describe('printAst: patterns', () => {
  test.each([
    ['_', '_'],
    ['n', 'n'],
    ['-1', '-1'],
    ['"s"', '"s"'],
    ['true', 'true'],
    ['nil', 'nil'],
    ['0..10', '0..10'],
    ['-5..=5', '-5..=5'],
    ['[a, ...rest, z]', '[a ...rest z]'],
    ['[a, ...]', '[a ...]'],
    ['{a, b: [c], "x y": d, "if": e}', '{a b:[c] "x y":d "if":e}'],
    ['1 | 2', '(| 1 2)'],
  ])('%j', (pattern, expected) => {
    expect(printed(`match v { ${pattern} => 0 }`)).toBe(`(program (match v (arm ${expected} 0)))`)
  })

  test('a range pattern with negative zero bounds keeps the sign', () => {
    // Arrange
    const range: Pattern = { kind: 'PRange', start: -0, end: 1, inclusive: false, span: at }

    // Act / Assert
    expect(printAst(range)).toBe('-0..1')
  })
})

describe('printAst: deep trees', () => {
  test('prints a 100,000-deep tree without recursing on the JavaScript stack', () => {
    // Arrange
    let expr: Expr = { kind: 'Ident', name: 'x', span: at }
    for (let i = 0; i < 100_000; i++) expr = { kind: 'Unary', op: '-', operand: expr, span: at }

    // Act
    const text = printAst(expr)

    // Assert
    expect(text.length).toBe(100_000 * 4 + 1)
    expect(text.startsWith('(- (- ')).toBe(true)
  })
})
