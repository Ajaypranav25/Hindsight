import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { printAst } from './ast-print'
import { lex } from './lexer'
import { parse } from './parser'
import { KEYWORDS, PUNCTUATORS } from './tokens'

/** Lexing and parsing never throw, and a syntax error is always the only diagnostic. */
function assertWellBehaved(source: string): void {
  const lexed = lex(source)
  expect(lexed.tokens.at(-1)?.kind).toBe('EOF')
  const result = parse(source)
  const syntax = result.diagnostics.filter((d) => ['E010', 'E011', 'E018', 'E028'].includes(d.code))
  if (syntax.length > 0) expect(result.diagnostics).toHaveLength(1)
  for (const d of result.diagnostics) {
    expect(d.span.start).toBeGreaterThanOrEqual(0)
    expect(d.span.end).toBeLessThanOrEqual(source.length)
    expect(d.span.start).toBeLessThanOrEqual(d.span.end)
  }
  if (result.diagnostics.length === 0) expect(typeof printAst(result.program)).toBe('string')
}

const FRAGMENTS = [
  ...KEYWORDS,
  ...PUNCTUATORS,
  'x',
  '_',
  'f',
  '0',
  '1.5',
  '1e3',
  '3abc',
  '"s"',
  '"a{',
  '}"',
  '"{x}"',
  '\\',
  '/*',
  '*/',
  '//',
  '!',
  '#',
  '\n',
  ' ',
  '\t',
]

const tokenSoup = fc
  .array(fc.constantFrom(...FRAGMENTS), { maxLength: 60 })
  .map((parts) => parts.join(' '))

const tightSoup = fc
  .array(fc.constantFrom(...FRAGMENTS), { maxLength: 60 })
  .map((parts) => parts.join(''))

describe('lex and parse never throw', () => {
  test('on arbitrary strings', () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), assertWellBehaved), { numRuns: 1000 })
  })

  test('on arbitrary unicode strings', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 100 }), assertWellBehaved), {
      numRuns: 500,
    })
  })

  test('on random token soups', () => {
    fc.assert(fc.property(tokenSoup, assertWellBehaved), { numRuns: 2000 })
    fc.assert(fc.property(tightSoup, assertWellBehaved), { numRuns: 2000 })
  })

  test.each<[string, string]>([
    ['parentheses', '('.repeat(100_000)],
    ['balanced parentheses', `${'('.repeat(50_000)}x${')'.repeat(50_000)}`],
    ['brackets', '['.repeat(100_000)],
    ['braces', '{'.repeat(100_000)],
    ['records', `x = ${'{a: '.repeat(50_000)}`],
    ['prefix minus', `${'-'.repeat(100_000)}1`],
    ['prefix not', `${'not '.repeat(50_000)}x`],
    ['lambdas', `${'|x| '.repeat(50_000)}x`],
    ['empty lambdas', `${'|| '.repeat(50_000)}x`],
    ['functions', 'fn(){ '.repeat(50_000)],
    ['powers', Array(50_000).fill('2').join(' ** ')],
    ['sums', Array(50_000).fill('2').join(' + ')],
    ['pipes', `x${' |> f'.repeat(50_000)}`],
    ['calls', `f${'(x)'.repeat(50_000)}`],
    ['else-if chains', `if a {}${' else if a {}'.repeat(50_000)}`],
    ['matches', 'match x { _ => '.repeat(50_000)],
    ['interpolations', `${'"{'.repeat(50_000)}x${'}"'.repeat(50_000)}`],
    ['unterminated interpolations', '"{'.repeat(100_000)],
    ['block comments', '/*'.repeat(100_000)],
    ['list patterns', `let ${'['.repeat(100_000)}`],
    ['record patterns', `let ${'{a: '.repeat(50_000)}`],
    ['alternatives', `match x { ${Array(50_000).fill('1').join(' | ')} => 0 }`],
    ['many statements', 'x\n'.repeat(100_000)],
  ])('on deeply nested input: %s', (_name, source) => {
    expect(() => assertWellBehaved(source)).not.toThrow()
  })

  test('on random nesting of openers and closers', () => {
    const nested = fc
      .array(fc.constantFrom('(', ')', '[', ']', '{', '}', '"{', '}"', '|x| ', '-', 'x', ','), {
        minLength: 200,
        maxLength: 2000,
      })
      .map((parts) => parts.join(''))
    fc.assert(fc.property(nested, assertWellBehaved), { numRuns: 200 })
  })
})
