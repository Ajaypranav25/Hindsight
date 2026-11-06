import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { formatLiteral, parseLiteralValue } from './literal'

describe('parseLiteralValue', () => {
  test.each([
    ['42', 42],
    ['-7', -7],
    ['  3.25  ', 3.25],
    ['- 2', -2],
    ['1_000', 1000],
    ['2.5e3', 2500],
    ['true', true],
    ['false', false],
    ['nil', null],
    ['"hi"', 'hi'],
    ['""', ''],
    ['"a\\nb\\t\\"c\\" \\{x\\} \\u{1F600}"', 'a\nb\t"c" {x} \u{1F600}'],
  ])('%s', (text, value) => {
    expect(parseLiteralValue(text)).toEqual({ ok: true, value })
  })

  test.each([
    ['', /Type a number/],
    ['   ', /Type a number/],
    ['total', /total is a name/],
    ['1 2', /Type a number/],
    ['-"a"', /Type a number/],
    ['"a{x}b"', /Type a number/],
    ['[1]', /Type a number/],
    ['"unterminated', /./],
    ['@', /./],
  ])('rejects %j', (text, message) => {
    const result = parseLiteralValue(text)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(message)
  })
})

describe('formatLiteral', () => {
  test.each([
    [null, 'nil'],
    [true, 'true'],
    [false, 'false'],
    [-1.5, '-1.5'],
    ['a{b}"\n\\', '"a\\{b\\}\\"\\n\\\\"'],
    ['\u0001\0', '"\\u{1}\\0"'],
  ])('%j', (value, text) => {
    expect(formatLiteral(value)).toBe(text)
  })

  test('reads back unchanged', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary' }),
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          fc.constantFrom(null, true, false),
        ),
        (value) => {
          const parsed = parseLiteralValue(formatLiteral(value))
          expect(parsed.ok).toBe(true)
          if (parsed.ok) expect(Object.is(parsed.value, value) || parsed.value === value).toBe(true)
        },
      ),
    )
  })
})
