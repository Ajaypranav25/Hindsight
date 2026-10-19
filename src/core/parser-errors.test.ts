import { describe, expect, test } from 'vitest'
import { parse } from './parser'

type Reported = [code: string, message: string, start: number, end: number, hint?: string]

function reported(source: string): Reported[] {
  return parse(source).diagnostics.map((d): Reported => {
    const { code, message, span, hint } = d
    return hint === undefined
      ? [code, message, span.start, span.end]
      : [code, message, span.start, span.end, hint]
  })
}

/** The only diagnostic of `source` (a syntax error is always alone). */
function only(source: string): Reported {
  const all = reported(source)
  expect(all).toHaveLength(1)
  return all[0]!
}

describe('parse: lexer diagnostics', () => {
  test('lexer errors are returned as they are, with an empty program and no parsing', () => {
    // Arrange / Act
    const result = parse('let x = # )')

    // Assert
    expect(result.program.body).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toEqual(['E001'])
  })
})

describe('parse: E010 expected token', () => {
  test.each<[string, string, number, number]>([
    ['f(1 2)', "expected ')' but found number 2", 4, 5],
    ['[1 2]', "expected ']' but found number 2", 3, 4],
    ['({a: 1 b: 2})', "expected '}' but found identifier 'b'", 7, 8],
    ['fn f(a b) {}', "expected ')' but found identifier 'b'", 7, 8],
    ['fn(a b) {}', "expected ')' but found identifier 'b'", 5, 6],
    ['|a b| a', "expected '|' but found identifier 'b'", 3, 4],
    ['let [a b] = x', "expected ']' but found identifier 'b'", 7, 8],
    ['let {a b} = x', "expected '}' but found identifier 'b'", 7, 8],
    ['let [...1] = x', "expected ']' but found number 1", 8, 9],
    ['(a b)', "expected ')' but found identifier 'b'", 3, 4],
    ['a[1 2]', "expected ']' but found number 2", 4, 5],
    ['"{a b}"', "expected '}' but found identifier 'b'", 4, 5],
    ['let x 5', "expected '=' but found number 5", 6, 7],
    ['for x of xs {}', "expected 'in' but found identifier 'of'", 6, 8],
    ['if a 1', "expected '{' but found number 1", 5, 6],
    ['while a 1', "expected '{' but found number 1", 8, 9],
    ['for x in xs 1', "expected '{' but found number 1", 12, 13],
    ['fn f() 1', "expected '{' but found number 1", 7, 8],
    ['if a {} else 1', "expected '{' but found number 1", 13, 14],
    ['match x 1', "expected '{' but found number 1", 8, 9],
    ['match x { 1 2 }', "expected '=>' but found number 2", 12, 13],
    ['match x { 1 if a 2 }', "expected '=>' but found number 2", 17, 18],
    ['a.1', 'expected an identifier but found number 1', 2, 3],
    ['a.if', "expected an identifier but found keyword 'if'", 2, 4],
    ['fn 5', 'expected an identifier but found number 5', 3, 4],
    ['({1: 2})', 'expected an identifier but found number 1', 2, 3],
    ['({if: 2})', "expected an identifier but found keyword 'if'", 2, 4],
    ['({"a{x}": 2})', 'expected an identifier but found string', 2, 5],
    ['fn f 1', "expected '(' but found number 1", 5, 6],
    ['(fn 1)', "expected '(' but found number 1", 4, 5],
    ['({"a" 1})', "expected ':' but found number 1", 6, 7],
    ['let {"k" p} = r', "expected ':' but found identifier 'p'", 9, 10],
    ['{ a', "expected '}' but found end of file", 3, 3],
    ['match x {\n 1 => 2\n', "expected '}' but found end of file", 17, 17],
    ['match x { 1 => 2', "expected '}' but found end of file", 16, 16],
    ['{ a // note\n  ', "expected '}' but found end of file", 11, 11],
    ['fn f(a) { a /* c */ ', "expected '}' but found end of file", 19, 19],
    ['x.', 'expected an identifier but found end of file', 2, 2],
    ['({a', "expected '}' but found end of file", 3, 3],
  ])('%j', (source, message, start, end) => {
    expect(only(source)).toEqual(['E010', message, start, end])
  })
})

describe('parse: E011 expected an expression', () => {
  test.each<[string, string, number, number]>([
    ['1 +', 'end of file', 3, 3],
    ['a = ', 'end of file', 3, 3],
    ['}', "'}'", 0, 1],
    [')', "')'", 0, 1],
    [';', "';'", 0, 1],
    ['a;;', "';'", 2, 3],
    ['{ ; }', "';'", 2, 3],
    ['"{}"', 'string', 2, 4],
    ['f(,)', "','", 2, 3],
    ['[1, ,]', "','", 4, 5],
    ['()', "')'", 1, 2],
    ['1 == not x', "keyword 'not'", 5, 8],
    ['-not x', "keyword 'not'", 1, 4],
    ['1 + not x', "keyword 'not'", 4, 7],
    ['x ** not y', "keyword 'not'", 5, 8],
    ['a..not b', "keyword 'not'", 3, 6],
    ['else', "keyword 'else'", 0, 4],
    ['let x = let', "keyword 'let'", 8, 11],
    ['x\n= 1', "'='", 2, 3],
    ['match x { 1 => }', "'}'", 15, 16],
    ['f(...xs)', "'...'", 2, 5],
  ])('%j', (source, found, start, end) => {
    expect(only(source)).toEqual(['E011', `expected an expression but found ${found}`, start, end])
  })
})

describe('parse: E015 invalid pattern', () => {
  test.each<[string, number, number]>([
    ['let "a{x}" = 1', 4, 7],
    ['let (a) = 1', 4, 5],
    ['let -x = 1', 4, 5],
    ['let if = 1', 4, 6],
    ['let ... = 1', 4, 7],
    ['let {1} = r', 5, 6],
    ['let {...r} = r', 5, 8],
    ['let [,] = x', 5, 6],
    ['let = 1', 4, 5],
    ['let', 3, 3],
    ['match x { , }', 10, 11],
    ['match x { 1 => 2,, }', 17, 18],
    ['let a(b) = 1', 5, 6],
    ['let a[0] = 1', 5, 6],
    ['let a.b = 1', 5, 6],
    ['let "s"..1 = x', 7, 9],
    ['let 1..2..3 = x', 8, 10],
    ['let 1..x = 1', 7, 8],
    ['let 1..-x = 1', 7, 8],
    ['let 1.. = x', 8, 9],
    ['|a + 1| 0', 3, 4],
    ['|a|> 0', 2, 4],
    ['match x { {a(} => 0 }', 12, 13],
    ['for [a] + 1 in x {}', 8, 9],
  ])('%j', (source, start, end) => {
    expect(only(source)).toEqual(['E015', 'invalid pattern', start, end])
  })

  test.each(['+', '-', '*', '/', '%', '**', '==', '!=', '<', '<=', '>', '>=', 'and', 'or', '|>'])(
    'a pattern followed by %s',
    (op) => {
      expect(only(`let a ${op} b = 1`)).toEqual(['E015', 'invalid pattern', 6, 6 + op.length])
    },
  )

  test('assignment operators after a pattern are E010 with the context expectation', () => {
    expect(only('let a += 1')).toEqual(['E010', "expected '=' but found '+='", 6, 8])
  })
})

describe('parse: E018 statement and arm separation', () => {
  test.each<[string, number, number]>([
    ['a b', 2, 3],
    ['let x = 1 2', 10, 11],
    ['break 1', 6, 7],
    ['if a {} b', 8, 9],
    ['{ a b }', 4, 5],
    ['a = 1 = 2', 6, 7],
    ['fn f() {} f()', 10, 11],
  ])('%j', (source, start, end) => {
    expect(only(source)).toEqual([
      'E018',
      "expected a newline or ';' between statements",
      start,
      end,
    ])
  })

  test.each<[string, number, number]>([
    ['match x { 1 => 2 3 => 4 }', 17, 18],
    ['match x { 1 => 2; 3 => 4 }', 16, 17],
    ['match x { 1 => { a } 2 => b }', 21, 22],
  ])('%j', (source, start, end) => {
    expect(only(source)).toEqual([
      'E018',
      "expected a newline or ',' between match arms",
      start,
      end,
    ])
  })
})

describe('parse: E028 nesting limits', () => {
  const deep = (open: string, count: number, middle: string, close: string): string =>
    open.repeat(count) + middle + close.repeat(count)

  test('256 open parentheses are allowed, 257 are not', () => {
    expect(reported(deep('(', 256, 'x', ')'))).toEqual([])
    expect(only(deep('(', 257, 'x', ')'))).toEqual([
      'E028',
      'expression is nested too deeply',
      256,
      257,
    ])
  })

  test.each<[string, string, number, number]>([
    ['brackets', deep('[', 300, '', ']'), 256, 257],
    ['blocks', deep('{', 300, '', '}'), 256, 257],
    ['prefix minus', `${'-'.repeat(300)}x`, 256, 257],
    ['prefix not', `${'not '.repeat(300)}x`, 1024, 1027],
    ['interpolations', deep('"{', 300, 'x', '}"'), 512, 514],
    ['list patterns', `let ${deep('[', 300, '', ']')} = x`, 260, 261],
  ])('more than 256 open %s', (_name, source, start, end) => {
    expect(only(source)).toEqual(['E028', 'expression is nested too deeply', start, end])
  })

  test.each<[string, string]>([
    ['a chain of 600 + operators', Array(601).fill('1').join(' + ')],
    ['a chain of 600 ** operators', Array(601).fill('2').join(' ** ')],
    ['600 pipes', `a${' |> f'.repeat(600)}`],
    ['600 member accesses', `a${'.b'.repeat(600)}`],
    ['600 calls', `f${'()'.repeat(600)}`],
    ['600 nested lambdas', `${'|x| '.repeat(600)}x`],
    ['600 else-if branches', `if a {}${' else if a {}'.repeat(600)}`],
    ['600 nested matches', `${'match x { _ => '.repeat(600)}`],
  ])('a tree deeper than 512 levels: %s', (_name, source) => {
    expect(only(source)[0]).toBe('E028')
  })

  test.each<[string, string]>([
    ['a chain of 400 + operators', Array(401).fill('1').join(' + ')],
    ['400 nested lambdas', `${'|x| '.repeat(400)}x`],
    ['many sequential nested constructs', '[[[(x)]]]\n'.repeat(2000)],
  ])('deep but allowed: %s', (_name, source) => {
    expect(reported(source)).toEqual([])
  })
})

describe('parse: checks after parsing (SPEC §3.6)', () => {
  test.each<[string, Reported[]]>([
    ['1 = 2', [['E012', 'invalid assignment target', 0, 1]]],
    ['f() = 1', [['E012', 'invalid assignment target', 0, 3]]],
    ['(a + b) = 1', [['E012', 'invalid assignment target', 0, 7]]],
    ['[a, b] = xs', [['E012', 'invalid assignment target', 0, 6]]],
    ['_ = 1', [['E012', 'invalid assignment target', 0, 1]]],
    ['_ += 1', [['E012', 'invalid assignment target', 0, 1]]],
    ['(_) = 1', [['E012', 'invalid assignment target', 0, 3]]],
    ['_.x = 1', [['E027', "'_' can only be used in patterns", 0, 1]]],
    ['_[0] = 1', [['E027', "'_' can only be used in patterns", 0, 1]]],
    ['f(_)', [['E027', "'_' can only be used in patterns", 2, 3]]],
    ['({_})', [['E027', "'_' can only be used in patterns", 2, 3]]],
    ['x = _', [['E027', "'_' can only be used in patterns", 4, 5]]],
    [
      'a < b < c',
      [['E013', 'comparison operators cannot be chained', 6, 7, "write 'a < b and b < c'"]],
    ],
    [
      'a == b != c < d',
      [
        ['E013', 'comparison operators cannot be chained', 7, 9, "write 'a < b and b < c'"],
        ['E013', 'comparison operators cannot be chained', 12, 13, "write 'a < b and b < c'"],
      ],
    ],
    ['1..2..3', [['E014', 'range operators cannot be chained', 4, 6]]],
    ['1..2..=3', [['E014', 'range operators cannot be chained', 4, 7]]],
    [
      'let [...a, ...b, ...c] = x',
      [
        ['E016', "a list pattern can contain at most one '...rest'", 11, 14],
        ['E016', "a list pattern can contain at most one '...rest'", 17, 20],
      ],
    ],
    ['({a: 1, a: 2})', [['E019', "duplicate field 'a' in record literal", 8, 9]]],
    [
      '({a, "a": 1, a})',
      [
        ['E019', "duplicate field 'a' in record literal", 5, 8],
        ['E019', "duplicate field 'a' in record literal", 13, 14],
      ],
    ],
    ['({...r, ...r})', []],
    ['let [a, a] = x', [['E023', "duplicate binding 'a'", 8, 9]]],
    ['let [_, _] = x', []],
    ['let {a, b: a} = r', [['E023', "duplicate binding 'a'", 11, 12]]],
    ['let [a, ...a] = x', [['E023', "duplicate binding 'a'", 11, 12]]],
    ['fn f(a, a) {}', [['E023', "duplicate binding 'a'", 8, 9]]],
    ['|a, [a]| 0', [['E023', "duplicate binding 'a'", 5, 6]]],
    ['for [a, a] in x {}', [['E023', "duplicate binding 'a'", 8, 9]]],
    ['match x { [a, a] => 0 }', [['E023', "duplicate binding 'a'", 14, 15]]],
  ])('%j', (source, expected) => {
    expect(reported(source)).toEqual(expected)
  })

  const ALT = "alternatives ('|') are only allowed in match patterns"
  const BIND = 'alternative patterns cannot bind variables'
  const BIND_HINT = "use '_' instead of a name inside alternatives"

  test.each<[string, Reported[]]>([
    ['let 1 | 2 = x', [['E015', ALT, 6, 7]]],
    ['let [1 | 2, 3 | 4] = x', [['E015', ALT, 7, 8]]],
    ['let [a | b] = x', [['E015', ALT, 7, 8]]],
    [
      'fn f(a | b, c | d) {}',
      [
        ['E015', ALT, 7, 8],
        ['E015', ALT, 14, 15],
      ],
    ],
    ['fn(1 | 2) {}', [['E015', ALT, 5, 6]]],
    ['|[1 | 2]| 0', [['E015', ALT, 4, 5]]],
    ['for 1 | 2 in x {}', [['E015', ALT, 6, 7]]],
    ['match x { a | 1 => 0 }', [['E017', BIND, 10, 11, BIND_HINT]]],
    [
      'match x { [a] | {b} => 0 }',
      [
        ['E017', BIND, 11, 12, BIND_HINT],
        ['E017', BIND, 17, 18, BIND_HINT],
      ],
    ],
    ['match x { [...r] | _ => 0 }', [['E017', BIND, 14, 15, BIND_HINT]]],
    ['match x { [a, 1 | 2] => a }', []],
    ['match x { 1 | 2 | 3 => 0 }', []],
  ])('alternatives: %j', (source, expected) => {
    expect(reported(source)).toEqual(expected)
  })

  test('every occurrence is reported, sorted by position', () => {
    // Arrange
    const source = 'let [a, a] = _\n1 = 2\nx < y < z\nmatch v { q | 1 => 0 }'

    // Act / Assert
    expect(reported(source).map(([code, , start]) => [code, start])).toEqual([
      ['E023', 8],
      ['E027', 13],
      ['E012', 15],
      ['E013', 27],
      ['E017', 41],
    ])
  })

  test('a program with check errors still returns its tree', () => {
    expect(parse('1 = 2').program.body).toHaveLength(1)
  })

  test('a syntax error suppresses every check and is the only diagnostic', () => {
    // Arrange / Act
    const result = parse('a < b < c\n1 = 2\nf(')

    // Assert
    expect(result.program.body).toEqual([])
    expect(reported('a < b < c\n1 = 2\nf(')).toEqual([
      ['E011', 'expected an expression but found end of file', 18, 18],
    ])
  })

  test('only the first syntax error is reported', () => {
    expect(reported('f(1 2)\n)\nlet = 1')).toEqual([
      ['E010', "expected ')' but found number 2", 4, 5],
    ])
  })
})
