import { describe, expect, test } from 'vitest'
import { lex } from './lexer'
import { KEYWORDS, PUNCTUATORS } from './tokens'
import type { Token } from './tokens'

/** Compact token rendering: `kind` for keywords/punctuators, `Kind(value)` for the rest. EOF omitted. */
function render(token: Token): string {
  if (token.value === undefined) return token.kind
  const value = typeof token.value === 'number' ? String(token.value) : JSON.stringify(token.value)
  return `${token.kind}(${value})`
}

function tokens(source: string): string[] {
  return lex(source)
    .tokens.filter((token) => token.kind !== 'EOF')
    .map(render)
}

function spans(source: string): [number, number][] {
  return lex(source).tokens.map((token) => [token.start, token.end])
}

function newlineFlags(source: string): boolean[] {
  return lex(source).tokens.map((token) => token.newlineBefore)
}

function diagnostics(
  source: string,
): { code: string; message: string; span: [number, number]; hint?: string }[] {
  return lex(source).diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
    span: [d.span.start, d.span.end],
    ...(d.hint === undefined ? {} : { hint: d.hint }),
  }))
}

describe('lex: source text and the EOF token', () => {
  test('an empty source yields only EOF at [0, 0]', () => {
    // Arrange / Act
    const result = lex('')

    // Assert
    expect(result.tokens).toEqual([{ kind: 'EOF', start: 0, end: 0, newlineBefore: false }])
    expect(result.comments).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  test('the EOF token sits at [len, len] after trailing whitespace', () => {
    // Arrange
    const source = 'x  \n\t'

    // Act
    const eof = lex(source).tokens.at(-1)

    // Assert
    expect(eof).toEqual({ kind: 'EOF', start: 5, end: 5, newlineBefore: true })
  })

  test('a byte-order mark at offset 0 is ignored but offsets keep counting it', () => {
    // Arrange / Act / Assert
    expect(tokens('﻿let')).toEqual(['let'])
    expect(spans('﻿let')).toEqual([
      [1, 4],
      [4, 4],
    ])
    expect(lex('﻿let').diagnostics).toEqual([])
  })

  test('a byte-order mark anywhere else is an unexpected character', () => {
    // Arrange / Act / Assert
    expect(diagnostics('a﻿')).toEqual([
      { code: 'E001', message: "unexpected character '﻿'", span: [1, 2] },
    ])
  })
})

describe('lex: identifiers and keywords', () => {
  test.each(KEYWORDS)('the keyword %s lexes as its own kind without a value', (keyword) => {
    // Arrange / Act
    const [token] = lex(keyword).tokens

    // Assert
    expect(token).toEqual({ kind: keyword, start: 0, end: keyword.length, newlineBefore: false })
  })

  test('identifiers carry their name, including the lone underscore', () => {
    // Arrange / Act / Assert
    expect(tokens('_ _a1 abc_DEF9 x')).toEqual([
      'Identifier("_")',
      'Identifier("_a1")',
      'Identifier("abc_DEF9")',
      'Identifier("x")',
    ])
  })

  test('words that merely start with a keyword are identifiers', () => {
    // Arrange / Act / Assert
    expect(tokens('iff letx nil_ true1 fns')).toEqual([
      'Identifier("iff")',
      'Identifier("letx")',
      'Identifier("nil_")',
      'Identifier("true1")',
      'Identifier("fns")',
    ])
  })

  test('non-ASCII letters are not identifier characters', () => {
    // Arrange / Act / Assert
    expect(tokens('aé')).toEqual(['Identifier("a")'])
    expect(diagnostics('aé')).toEqual([
      { code: 'E001', message: "unexpected character 'é'", span: [1, 2] },
    ])
  })
})

describe('lex: punctuators', () => {
  const plain = PUNCTUATORS.filter((p) => p !== '{' && p !== '}')

  test.each(plain)('%s lexes as a single punctuator token', (punctuator) => {
    // Arrange / Act
    const result = lex(punctuator)

    // Assert
    expect(result.tokens.map((t) => t.kind)).toEqual([punctuator, 'EOF'])
    expect(result.diagnostics).toEqual([])
  })

  test('braces outside strings are plain punctuators', () => {
    // Arrange / Act / Assert
    expect(tokens('{ } }{')).toEqual(['{', '}', '}', '{'])
  })

  test.each([
    ['....', ['...', '.']],
    ['..=.', ['..=', '.']],
    ['...=', ['...', '=']],
    ['**=', ['**', '=']],
    ['***', ['**', '*']],
    ['===', ['==', '=']],
    ['=>=', ['=>', '=']],
    ['==>', ['==', '>']],
    ['!==', ['!=', '=']],
    ['<==', ['<=', '=']],
    ['>==', ['>=', '=']],
    ['|>>', ['|>', '>']],
    ['||', ['|', '|']],
    ['|||>', ['|', '|', '|>']],
    ['+=+', ['+=', '+']],
    ['-->', ['-', '-', '>']],
    ['%==', ['%=', '=']],
    ['/==', ['/=', '=']],
    ['a/b', ['Identifier("a")', '/', 'Identifier("b")']],
  ])('longest match: %s', (source, expected) => {
    // Arrange / Act / Assert
    expect(tokens(source)).toEqual(expected)
  })
})

describe('lex: numbers', () => {
  test.each([
    ['0', 0],
    ['42', 42],
    ['007', 7],
    ['3.14', 3.14],
    ['1_000_000', 1_000_000],
    ['1_', 1],
    ['1__0', 10],
    ['1e3', 1000],
    ['1E3', 1000],
    ['1e+3', 1000],
    ['1e-3', 0.001],
    ['2.5e-3', 0.0025],
    ['1_0.0_1e1_0', 10.01e10],
    ['1_e5', 100000],
    ['1e400', Infinity],
  ])('%s has the value %d', (source, value) => {
    // Arrange / Act
    const result = lex(source)

    // Assert
    expect(result.diagnostics).toEqual([])
    expect(result.tokens[0]).toEqual({
      kind: 'Number',
      start: 0,
      end: source.length,
      newlineBefore: false,
      value,
    })
  })

  test.each([
    ['1..5', ['Number(1)', '..', 'Number(5)']],
    ['1..=5', ['Number(1)', '..=', 'Number(5)']],
    ['1...5', ['Number(1)', '...', 'Number(5)']],
    ['1.', ['Number(1)', '.']],
    ['1.x', ['Number(1)', '.', 'Identifier("x")']],
    ['1._5', ['Number(1)', '.', 'Identifier("_5")']],
    ['1.e5', ['Number(1)', '.', 'Identifier("e5")']],
    ['.5', ['.', 'Number(5)']],
    ['-5', ['-', 'Number(5)']],
    ['1.5.6', ['Number(1.5)', '.', 'Number(6)']],
    ['1 abc', ['Number(1)', 'Identifier("abc")']],
  ])('a dot belongs to a number only when a digit follows: %s', (source, expected) => {
    // Arrange / Act / Assert
    expect(tokens(source)).toEqual(expected)
  })

  test.each([
    ['3abc', '3abc', ''],
    ['1e', '1e', ''],
    ['0x1F', '0x1F', ''],
    ['1_a', '1_a', ''],
    ['12abc_3', '12abc_3', ''],
    ['1.5e', '1.5e', ''],
    ['1e5e5', '1e5e5', ''],
    ['1e+3abc', '1e+3abc', ''],
    ['1e+', '1e', '+'],
    ['1e-x', '1e', '-'],
  ])('%s is E004 for the run %s as one NaN number token', (source, lexeme, rest) => {
    // Arrange / Act
    const result = lex(source)

    // Assert
    expect(result.diagnostics).toEqual([
      {
        code: 'E004',
        severity: 'error',
        message: `invalid number literal '${lexeme}'`,
        span: { start: 0, end: lexeme.length },
      },
    ])
    expect(result.tokens[0]).toMatchObject({ kind: 'Number', start: 0, end: lexeme.length })
    expect(result.tokens[0]?.value).toBeNaN()
    expect(result.tokens[1]?.kind).toBe(rest === '' ? 'EOF' : rest)
  })
})

describe('lex: strings', () => {
  test('a plain string covers both quotes and carries its cooked text', () => {
    // Arrange / Act / Assert
    expect(lex('"plain"').tokens[0]).toEqual({
      kind: 'String',
      start: 0,
      end: 7,
      newlineBefore: false,
      value: 'plain',
    })
  })

  test('simple escapes are cooked', () => {
    // Arrange
    const source = String.raw`"\n\t\r\0\\\"\{\}"`

    // Act / Assert
    expect(tokens(source)).toEqual([`String(${JSON.stringify('\n\t\r\0\\"{}')})`])
    expect(lex(source).diagnostics).toEqual([])
  })

  test.each([
    [String.raw`"\u{41}"`, 'A'],
    [String.raw`"\u{0}"`, '\0'],
    [String.raw`"\u{000041}"`, 'A'],
    [String.raw`"\u{1F600}"`, '\u{1F600}'],
    [String.raw`"\u{10FFFF}"`, '\u{10FFFF}'],
    [String.raw`"\u{d800}"`, '\ud800'],
    [String.raw`"a\u{62}c"`, 'abc'],
  ])('the unicode escape %s cooks to its code point', (source, cooked) => {
    // Arrange / Act
    const result = lex(source)

    // Assert
    expect(result.diagnostics).toEqual([])
    expect(result.tokens[0]?.value).toBe(cooked)
  })

  test('raw line terminators inside strings are kept', () => {
    // Arrange / Act / Assert
    expect(lex('"a\nb\r\nc\rd"').tokens[0]?.value).toBe('a\nb\r\nc\rd')
  })

  test('a closing brace outside an interpolation is ordinary string content', () => {
    // Arrange / Act / Assert
    expect(tokens('"a}b"')).toEqual(['String("a}b")'])
  })

  test('escaped braces never start an interpolation', () => {
    // Arrange / Act / Assert
    expect(tokens(String.raw`"\{x\}"`)).toEqual(['String("{x}")'])
  })

  test('a comment marker inside a string is string content', () => {
    // Arrange / Act
    const result = lex('"// not /* a comment"')

    // Assert
    expect(result.comments).toEqual([])
    expect(result.tokens[0]?.value).toBe('// not /* a comment')
  })
})

describe('lex: string interpolation', () => {
  test('"a {x} b" lexes as StringHead, x, StringTail with brace-inclusive spans', () => {
    // Arrange
    const source = '"a {x} b"'

    // Act / Assert
    expect(tokens(source)).toEqual(['StringHead("a ")', 'Identifier("x")', 'StringTail(" b")'])
    expect(spans(source)).toEqual([
      [0, 4],
      [4, 5],
      [5, 9],
      [9, 9],
    ])
  })

  test('"{x}{y}" has empty head, middle and tail parts', () => {
    // Arrange
    const source = '"{x}{y}"'

    // Act / Assert
    expect(tokens(source)).toEqual([
      'StringHead("")',
      'Identifier("x")',
      'StringMiddle("")',
      'Identifier("y")',
      'StringTail("")',
    ])
    expect(spans(source)).toEqual([
      [0, 2],
      [2, 3],
      [3, 5],
      [5, 6],
      [6, 8],
      [8, 8],
    ])
  })

  test('strings nest inside interpolations', () => {
    // Arrange / Act / Assert
    expect(tokens('"n = {f("{k}")}"')).toEqual([
      'StringHead("n = ")',
      'Identifier("f")',
      '(',
      'StringHead("")',
      'Identifier("k")',
      'StringTail("")',
      ')',
      'StringTail("")',
    ])
  })

  test('braces nest inside interpolations', () => {
    // Arrange / Act / Assert
    expect(tokens('"{ {a: {}}.a }!"')).toEqual([
      'StringHead("")',
      '{',
      'Identifier("a")',
      ':',
      '{',
      '}',
      '}',
      '.',
      'Identifier("a")',
      'StringTail("!")',
    ])
  })

  test('a closing brace inside a nested string does not close the interpolation', () => {
    // Arrange / Act / Assert
    expect(tokens('"{ "}" }x"')).toEqual(['StringHead("")', 'String("}")', 'StringTail("x")'])
  })

  test('escapes are cooked in every string part', () => {
    // Arrange / Act / Assert
    expect(tokens(String.raw`"\t{x}\n{y}\""`)).toEqual([
      'StringHead("\\t")',
      'Identifier("x")',
      'StringMiddle("\\n")',
      'Identifier("y")',
      'StringTail("\\"")',
    ])
  })

  test('an empty interpolation lexes cleanly (the parser reports it)', () => {
    // Arrange / Act
    const result = lex('"{}"')

    // Assert
    expect(result.diagnostics).toEqual([])
    expect(tokens('"{}"')).toEqual(['StringHead("")', 'StringTail("")'])
  })

  test('comments inside an interpolation are comments', () => {
    // Arrange
    const source = '"{ x // note\n /* c */ }"'

    // Act
    const result = lex(source)

    // Assert
    expect(result.tokens.map(render)).toEqual([
      'StringHead("")',
      'Identifier("x")',
      'StringTail("")',
      'EOF',
    ])
    expect(result.comments).toEqual([
      { start: 5, end: 12 },
      { start: 14, end: 21 },
    ])
  })
})

describe('lex: comments', () => {
  test('a line comment runs to the end of the line and is recorded', () => {
    // Arrange
    const source = 'a // one\nb // two'

    // Act
    const result = lex(source)

    // Assert
    expect(result.tokens.map(render)).toEqual(['Identifier("a")', 'Identifier("b")', 'EOF'])
    expect(result.comments).toEqual([
      { start: 2, end: 8 },
      { start: 11, end: 17 },
    ])
  })

  test('a line comment stops before \\r and \\r\\n terminators', () => {
    // Arrange / Act / Assert
    expect(lex('// a\r\nb').comments).toEqual([{ start: 0, end: 4 }])
    expect(lex('// a\rb').comments).toEqual([{ start: 0, end: 4 }])
  })

  test('block comments nest and form one comment', () => {
    // Arrange
    const source = 'x /* a /* b */ c */ y'

    // Act
    const result = lex(source)

    // Assert
    expect(result.tokens.map(render)).toEqual(['Identifier("x")', 'Identifier("y")', 'EOF'])
    expect(result.comments).toEqual([{ start: 2, end: 19 }])
    expect(result.diagnostics).toEqual([])
  })

  test('/**/ is a complete comment and /*/ is not', () => {
    // Arrange / Act / Assert
    expect(lex('/**/').diagnostics).toEqual([])
    expect(diagnostics('/*/')).toEqual([
      { code: 'E005', message: 'unterminated block comment', span: [0, 2] },
    ])
  })

  test('slashes that do not start a comment are operators', () => {
    // Arrange / Act / Assert
    expect(tokens('a / b /= c')).toEqual([
      'Identifier("a")',
      '/',
      'Identifier("b")',
      '/=',
      'Identifier("c")',
    ])
  })
})

describe('lex: newlineBefore', () => {
  test('the first token never has a newline before it', () => {
    // Arrange / Act / Assert
    expect(newlineFlags('\n\n  x')).toEqual([false, false])
  })

  test.each([
    ['a\nb', true],
    ['a\r\nb', true],
    ['a\rb', true],
    ['a b', false],
    ['a // c\nb', true],
    ['a /* \n */ b', true],
    ['a /* \r */ b', true],
    ['a /* c */ b', false],
    ['"x\ny" b', false],
  ])('between the tokens of %j the flag is %s', (source, flag) => {
    // Arrange / Act / Assert
    expect(newlineFlags(source)[1]).toBe(flag)
  })

  test('string parts carry the flag of the whitespace before their brace', () => {
    // Arrange / Act / Assert
    expect(newlineFlags('"{x\n}"')).toEqual([false, false, true, false])
  })
})

describe('lex: unexpected characters (E001)', () => {
  test.each([
    ['!', "use 'not' for negation or '!=' for inequality"],
    ['&', "use 'and'"],
    ["'", 'strings use double quotes'],
    ['`', 'strings use double quotes'],
    ['#', 'comments start with //'],
  ])('%s carries its hint', (character, hint) => {
    // Arrange / Act / Assert
    expect(diagnostics(`a ${character} b`)).toEqual([
      { code: 'E001', message: `unexpected character '${character}'`, span: [2, 3], hint },
    ])
  })

  test('other characters have no hint', () => {
    // Arrange / Act / Assert
    expect(diagnostics('@')).toEqual([
      { code: 'E001', message: "unexpected character '@'", span: [0, 1] },
    ])
  })

  test('every occurrence is reported and lexing continues', () => {
    // Arrange
    const source = 'a @@ b && c'

    // Act / Assert
    expect(tokens(source)).toEqual(['Identifier("a")', 'Identifier("b")', 'Identifier("c")'])
    expect(diagnostics(source).map((d) => d.span)).toEqual([
      [2, 3],
      [3, 4],
      [7, 8],
      [8, 9],
    ])
  })

  test('a surrogate pair is one code point', () => {
    // Arrange / Act / Assert
    expect(diagnostics('\u{1F600}')).toEqual([
      { code: 'E001', message: "unexpected character '\u{1F600}'", span: [0, 2] },
    ])
  })

  test('a lone surrogate is one code point of one unit', () => {
    // Arrange / Act / Assert
    expect(diagnostics('\ud800x')).toEqual([
      { code: 'E001', message: "unexpected character '\ud800'", span: [0, 1] },
    ])
  })

  test.each(['\v', '\f', ' ', ' ', '\0'])('the character %j is not whitespace', (character) => {
    // Arrange / Act / Assert
    expect(diagnostics(character).map((d) => d.code)).toEqual(['E001'])
  })
})

describe('lex: escape errors (E003)', () => {
  test('an unknown escape keeps the character and continues', () => {
    // Arrange
    const source = String.raw`"a\qb"`

    // Act / Assert
    expect(diagnostics(source)).toEqual([
      { code: 'E003', message: String.raw`unknown escape sequence '\q'`, span: [2, 4] },
    ])
    expect(lex(source).tokens[0]?.value).toBe('aqb')
  })

  test('an unknown escape of a surrogate pair spans the whole code point', () => {
    // Arrange / Act / Assert
    expect(diagnostics('"\\\u{1F600}"')).toEqual([
      { code: 'E003', message: "unknown escape sequence '\\\u{1F600}'", span: [1, 4] },
    ])
  })

  test.each([
    [String.raw`"\u41"`, [1, 3]],
    [String.raw`"\u{}"`, [1, 5]],
    [String.raw`"\u{1234567}"`, [1, 12]],
    [String.raw`"\u{110000}"`, [1, 11]],
    [String.raw`"\u{12"`, [1, 6]],
    [String.raw`"\u{12 }"`, [1, 6]],
    [String.raw`"\u{g}"`, [1, 4]],
  ])('%s is an invalid unicode escape at %j', (source, span) => {
    // Arrange / Act / Assert
    expect(diagnostics(source)).toEqual([{ code: 'E003', message: 'invalid unicode escape', span }])
  })

  test('every escape error is reported', () => {
    // Arrange / Act / Assert
    expect(diagnostics(String.raw`"\q{x}\w"`).map((d) => d.span)).toEqual([
      [1, 3],
      [6, 8],
    ])
  })
})

describe('lex: unterminated constructs at end of file', () => {
  test('an open string is E002 at its opening quote', () => {
    // Arrange / Act / Assert
    expect(diagnostics('x = "abc')).toEqual([
      { code: 'E002', message: 'unterminated string', span: [4, 5] },
    ])
  })

  test('a string reopened after an interpolation is E002 at its first quote', () => {
    // Arrange / Act / Assert
    expect(diagnostics('"{x} abc')).toEqual([
      { code: 'E002', message: 'unterminated string', span: [0, 1] },
    ])
  })

  test('a trailing backslash in an open string reports only E002', () => {
    // Arrange / Act / Assert
    expect(diagnostics('"abc\\')).toEqual([
      { code: 'E002', message: 'unterminated string', span: [0, 1] },
    ])
  })

  test('an open block comment is E005 at its outermost opener', () => {
    // Arrange / Act / Assert
    expect(diagnostics('x /* a /* b */')).toEqual([
      { code: 'E005', message: 'unterminated block comment', span: [2, 4] },
    ])
  })

  test('an open interpolation is E006 at the brace of the outermost one', () => {
    // Arrange / Act / Assert
    expect(diagnostics('"a {"b {c')).toEqual([
      { code: 'E006', message: 'unterminated string interpolation', span: [3, 4] },
    ])
  })

  test.each([
    ['"{ "abc', 'E006'],
    ['"{ /* abc', 'E006'],
    ['"{ x // abc', 'E006'],
    ['/* "abc', 'E005'],
    ['"/* abc', 'E002'],
  ])('only the highest-priority error is reported for %j', (source, code) => {
    // Arrange / Act / Assert
    expect(diagnostics(source).map((d) => d.code)).toEqual([code])
  })

  test('the unterminated string still yields a token up to the end of the source', () => {
    // Arrange / Act
    const result = lex('"ab')

    // Assert
    expect(result.tokens.map(render)).toEqual(['String("ab")', 'EOF'])
    expect(result.tokens[0]).toMatchObject({ start: 0, end: 3 })
  })

  test('an unterminated block comment is still recorded as a comment', () => {
    // Arrange / Act / Assert
    expect(lex('a /* b').comments).toEqual([{ start: 2, end: 6 }])
  })

  test('all lexical diagnostics are sorted by position', () => {
    // Arrange / Act / Assert
    expect(diagnostics('@ "\\q 1x').map((d) => d.code)).toEqual(['E001', 'E002', 'E003'])
  })
})
