import { describe, expect, test } from 'vitest'
import type { CellObj, IteratorObj, ListObj, Value } from './runtime-types'
import {
  deepList,
  makeClosure,
  makeList,
  makeNative,
  makeRange,
  makeRecord,
} from './testing/fixtures'
import { formatNumber, preview, repr, reprKey, reprWithin, show, showWithin } from './values'

describe('show and repr of primitives (SPEC §4.3)', () => {
  const cases: [Value, string][] = [
    [null, 'nil'],
    [true, 'true'],
    [false, 'false'],
    [3, '3'],
    [0.5, '0.5'],
    [-0, '0'],
    [1e21, '1e+21'],
    [1e-7, '1e-7'],
    [-2.5, '-2.5'],
    [Number.NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
    [0.1 + 0.2, '0.30000000000000004'],
  ]

  test.each(cases)('%o shows as %s', (value, text) => {
    expect(show(value)).toBe(text)
    expect(repr(value)).toBe(text)
  })

  test('formatNumber is JavaScript String(n)', () => {
    expect(formatNumber(123456789012345680000)).toBe('123456789012345680000')
    expect(formatNumber(-0)).toBe('0')
  })
})

describe('strings', () => {
  test('show is the string itself; repr quotes it', () => {
    expect(show('hi there')).toBe('hi there')
    expect(repr('hi there')).toBe('"hi there"')
    expect(repr('')).toBe('""')
  })

  test('repr escapes backslash, quote, newline, tab, carriage return and control units', () => {
    expect(repr('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(repr('1\n2\t3\r4')).toBe('"1\\n2\\t3\\r4"')
    expect(repr('\0\u001b\u001f')).toBe('"\\u{0}\\u{1b}\\u{1f}"')
  })

  test('repr leaves other code units alone', () => {
    expect(repr('\u007f é 😀 {x}')).toBe('"\u007f é 😀 {x}"')
  })

  test('strings nested in containers use repr', () => {
    expect(show(makeList('a', makeList('b"c')))).toBe('["a", ["b\\"c"]]')
  })
})

describe('lists and records', () => {
  test('lists print their items with repr', () => {
    expect(show(makeList())).toBe('[]')
    expect(show(makeList(1, 'a', null, true, makeList()))).toBe('[1, "a", nil, true, []]')
  })

  test('records print keys bare when they are identifiers and not keywords', () => {
    const record = makeRecord([
      ['a', 1],
      ['b c', 2],
      ['if', 3],
      ['_x9', 4],
      ['1a', 5],
      ['', 6],
      ['_', 7],
      ['nil', 8],
    ])
    expect(show(record)).toBe('{a: 1, "b c": 2, "if": 3, _x9: 4, "1a": 5, "": 6, _: 7, "nil": 8}')
    expect(show(makeRecord({}))).toBe('{}')
  })

  test('reprKey quotes and escapes non-identifier keys', () => {
    expect(reprKey('name')).toBe('name')
    expect(reprKey('while')).toBe('"while"')
    expect(reprKey('a\nb')).toBe('"a\\nb"')
  })

  test('nested records and lists', () => {
    const value = makeRecord({ xs: makeList(1, makeRecord({ k: 'v' })), e: makeRecord({}) })
    expect(show(value)).toBe('{xs: [1, {k: "v"}], e: {}}')
  })
})

describe('functions and ranges', () => {
  test('functions show their display names; builtins show as builtins', () => {
    expect(show(makeClosure('fib'))).toBe('<fn fib>')
    expect(show(makeClosure(null))).toBe('<fn>')
    expect(show(makeNative('print'))).toBe('<builtin print>')
    expect(show(makeClosure('map', -58))).toBe('<builtin map>')
    expect(show(makeList(makeNative('len'), makeClosure(null)))).toBe('[<builtin len>, <fn>]')
  })

  test('ranges show their bounds, or the range() form when the step is not 1', () => {
    expect(show(makeRange(0, 5))).toBe('0..5')
    expect(show(makeRange(1, 3, 1, true))).toBe('1..=3')
    expect(show(makeRange(-1, -5))).toBe('-1..-5')
    expect(show(makeRange(0.5, Infinity))).toBe('0.5..Infinity')
    expect(show(makeRange(0, 10, 2))).toBe('range(0, 10, 2)')
    expect(show(makeRange(10, 0, -1))).toBe('range(10, 0, -1)')
    expect(show(makeRange(0, 5, Number.NaN))).toBe('range(0, 5, NaN)')
  })

  test('internal objects have placeholder text', () => {
    const cell: CellObj = {
      type: 'cell',
      id: 3,
      open: true,
      stackIndex: 1,
      value: null,
      ownerFrameUid: 1,
      slot: 1,
    }
    const iterator: IteratorObj = { type: 'iterator', id: 4, source: null, position: 0, keys: null }
    expect(show(cell)).toBe('<cell>')
    expect(repr(iterator)).toBe('<iterator>')
  })
})

describe('cycles and sharing', () => {
  test('a list containing itself prints [...] for the inner reference', () => {
    const xs = makeList(1)
    xs.items.push(xs)
    expect(show(xs)).toBe('[1, [...]]')
  })

  test('a record containing itself prints {...}', () => {
    const r = makeRecord({ n: 1 })
    r.fields.set('self', r)
    expect(show(r)).toBe('{n: 1, self: {...}}')
    expect(show(makeRecord({ xs: makeList(r) }))).toBe('{xs: [{n: 1, self: {...}}]}')
  })

  test('mutual cycles print [...] at the repeated ancestor', () => {
    const a = makeList()
    const b = makeList(a)
    a.items.push(b)
    expect(show(a)).toBe('[[[...]]]')
  })

  test('shared references that are not cyclic print in full each time', () => {
    const a = makeList(1)
    expect(show(makeList(a, a))).toBe('[[1], [1]]')
    const r = makeRecord({ k: a })
    expect(show(makeList(r, makeList(r)))).toBe('[{k: [1]}, [{k: [1]}]]')
  })
})

describe('deep nesting', () => {
  test('a 100,000-deep list shows and reprs without recursion', () => {
    const deep = deepList(100_000)
    const text = show(deep)
    expect(text.length).toBe(200_000)
    expect(text.startsWith('[[[')).toBe(true)
    expect(text.endsWith(']]]')).toBe(true)
    expect(repr(deep)).toBe(text)
  })

  test('deeply nested records', () => {
    let value: Value = 1
    for (let i = 0; i < 100_000; i++) value = makeRecord({ a: value })
    const text = show(value)
    expect(text.length).toBe(100_000 * 5 + 1)
  })
})

describe('bounded rendering', () => {
  test('preview returns the full repr when it fits', () => {
    expect(preview(makeList(1, 2), 48)).toBe('[1, 2]')
    expect(preview('abc', 5)).toBe('"abc"')
  })

  test('preview cuts to maxLength - 1 code units plus an ellipsis', () => {
    const text = preview(makeList('abcdefghij', 'klmnopqrstuvwxyz'), 20)
    expect(text).toBe('["abcdefghij", "klm…')
    expect(text.length).toBe(20)
    expect(preview('a'.repeat(100), 60)).toBe('"' + 'a'.repeat(58) + '…')
  })

  test('preview stops reading items once it has enough text', () => {
    let reads = 0
    const items = new Proxy(
      Array.from({ length: 100_000 }, (_, i) => i),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads++
          return Reflect.get(target, key, receiver) as unknown
        },
      },
    )
    const list: ListObj = { type: 'list', id: 1, items }
    expect(preview(list, 10)).toBe('[0, 1, 2,…')
    expect(reads).toBeLessThan(10)
  })

  test('preview of a huge string does not escape the whole string', () => {
    const text = preview('\n'.repeat(1_000_000), 9)
    expect(text).toBe('"\\n\\n\\n\\…')
  })

  test('showWithin and reprWithin return null when the text exceeds the limit', () => {
    expect(showWithin('abc', 3)).toBe('abc')
    expect(showWithin('abcd', 3)).toBeNull()
    expect(reprWithin('abc', 5)).toBe('"abc"')
    expect(reprWithin('abc', 4)).toBeNull()
    expect(showWithin(makeList(1, 2, 3), 9)).toBe('[1, 2, 3]')
    expect(showWithin(makeList(1, 2, 3), 8)).toBeNull()
    expect(showWithin(7, 0)).toBeNull()
    expect(showWithin(null, 3)).toBe('nil')
  })

  test('preview with a tiny budget', () => {
    expect(preview(makeList(1, 2, 3), 1)).toBe('…')
    expect(preview(makeList(1, 2, 3), 0)).toBe('')
  })
})
