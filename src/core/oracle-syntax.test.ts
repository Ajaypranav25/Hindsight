import { describe, expect, test } from 'vitest'
import { pinsResult, scanOracleSyntax } from './oracle-syntax'
import { parse } from './parser'

function scan(source: string) {
  const parsed = parse(source)
  if (parsed.diagnostics.length > 0)
    throw new Error(`parse failed: ${JSON.stringify(parsed.diagnostics)}`)
  return scanOracleSyntax(parsed.program)
}

function clauseExpr(source: string) {
  const parsed = parse(`fn f(x) ensures ${source} { x }`)
  if (parsed.diagnostics.length > 0) throw new Error('parse failed')
  const statement = parsed.program.body[0]!
  if (statement.kind !== 'FnDecl') throw new Error('not a function')
  return statement.fn.contracts[0]!.expr
}

describe('scanOracleSyntax', () => {
  test('finds assertions written as examples wherever they are nested', () => {
    // Arrange
    const source = `fn f(n) { n }
var log = []
while len(log) < 1 { push(log, assert(f(1) == 1)) }
for i in [1] { if i > 0 { assert(2 == f(2)) } else { assert(f(3) == 3) } }
let r = {a: assert(f(4) == 4), ...{b: 1}}
let s = "{assert(f(5) == 5)}"
let l = [-f(0), ...[assert(f(6) == 6)]]
log[0] = assert(f(7) == 7)
print(match 1 { 1 if assert(f(8) == 8) => [1][0], _ => r.a })
fn g() { return assert(f(9) == 9) }
{ assert(f(10) == 10) }
assert((10 |> f()) == 10)
`

    // Act
    const { assertions } = scan(source)

    // Assert
    expect(assertions.map((example) => example.callee).sort()).toEqual(Array(11).fill('f'))
    const piped = assertions.find((example) =>
      source.slice(example.siteSpan.start).startsWith('|>'),
    )
    expect(piped).toBeDefined()
  })

  test('ignores assertions that are not examples', () => {
    // Arrange / Act
    const { assertions } = scan(`fn f(n) { n }
assert(true)
assert(f(1) > 0)
assert(1 == 1)
assert(f(1) == 1 and true)
let o = {g: f}
assert(o.g(1) == 1)
assert()
check(f(1) == 1)
fn check(c) { c }
`)

    // Assert
    expect(assertions).toEqual([])
  })

  test('finds pinning postconditions in nested functions and fn expressions', () => {
    // Arrange / Act
    const { pinned } = scan(`fn outer(n) {
  fn inner(m) ensures m > 0 and result == m * 2 { m * 2 }
  let anon = fn(k) ensures result == k { k }
  inner(n) + anon(n)
}
fn loose(n) ensures result > n { n + 1 }
`)

    // Assert
    expect(pinned.size).toBe(2)
  })
})

describe('pinsResult', () => {
  test.each([
    ['result == x * 2', true],
    ['x * 2 == result', true],
    ['x > 0 and (result == x)', true],
    ['result == result + 0', false],
    ['result != x', false],
    ['result == x or x == 0', false],
    ['result >= x', false],
    ['all([result], |r| r == x)', false],
  ])('%s pins the result: %s', (clause, expected) => {
    expect(pinsResult(clauseExpr(clause))).toBe(expected)
  })
})
