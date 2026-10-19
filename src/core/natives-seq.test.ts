import { describe, expect, test } from 'vitest'
import { err, ok, r019, shown } from './testing/native-checks'
import { makeClosure, makeList, makeRange, makeRecord } from './testing/fixtures'
import { SIZE_LIMIT, repr } from './values'

const TOO_LARGE = { code: 'R025', message: 'result too large' }

describe('list mutation natives', () => {
  test('push appends and pop removes the last item', () => {
    const list = makeList(1)
    expect(ok('push', list, 2)).toBeNull()
    expect(ok('pop', list)).toBe(2)
    expect(repr(list)).toBe('[1]')
    expect(err('push', 'x', 1)).toEqual(r019('push', 'a list', 1, 'a string'))
    expect(err('pop', makeList())).toEqual({
      code: 'R020',
      message: 'cannot pop from an empty list',
    })
    expect(err('pop', null)).toEqual(r019('pop', 'a list', 1, 'nil'))
  })

  test('push and insert respect the size limit', () => {
    const full = makeList()
    full.items.length = SIZE_LIMIT
    expect(err('push', full, 1)).toEqual(TOO_LARGE)
    expect(err('insert', full, 0, 1)).toEqual(TOO_LARGE)
  })

  test('insert accepts positions 0..=len, negative from the end', () => {
    const list = makeList(1, 2)
    ok('insert', list, 2, 3)
    ok('insert', list, -1, 9)
    ok('insert', list, 0, 0)
    expect(repr(list)).toBe('[0, 1, 2, 9, 3]')
    expect(err('insert', list, 6, 0)).toEqual({
      code: 'R007',
      message: 'index 6 is out of bounds for a list of length 5',
    })
    expect(err('insert', list, -6, 0).code).toBe('R007')
    expect(err('insert', list, '1', 0)).toEqual({
      code: 'R008',
      message: 'list index must be an integer, got "1"',
    })
    expect(err('insert', 1, 'x', 0)).toEqual(r019('insert', 'a list', 1, 'a number'))
  })

  test('remove removes and returns the item at an index', () => {
    const list = makeList(1, 2, 3)
    expect(ok('remove', list, -1)).toBe(3)
    expect(ok('remove', list, 0)).toBe(1)
    expect(repr(list)).toBe('[2]')
    expect(err('remove', list, 1)).toEqual({
      code: 'R007',
      message: 'index 1 is out of bounds for a list of length 1',
    })
    expect(err('remove', list, 0.5).code).toBe('R008')
  })
})

describe('sequence natives', () => {
  test('slice follows JavaScript slice for lists and strings', () => {
    expect(shown('slice', makeList(1, 2, 3, 4), 1, 3)).toBe('[2, 3]')
    expect(shown('slice', makeList(1, 2, 3), -2)).toBe('[2, 3]')
    expect(ok('slice', 'hello', 1.7, 100)).toBe('ello')
    expect(ok('slice', 'hello', -3, -1)).toBe('ll')
    expect(err('slice', 1, 0)).toEqual(r019('slice', 'a list or string', 1, 'a number'))
    expect(err('slice', 'x', '0')).toEqual(r019('slice', 'a number', 2, 'a string'))
    expect(err('slice', 'x', 0, null)).toEqual(r019('slice', 'a number', 3, 'nil'))
  })

  test('reverse returns a new list or reversed code units', () => {
    const list = makeList(1, 2)
    expect(shown('reverse', list)).toBe('[2, 1]')
    expect(repr(list)).toBe('[1, 2]')
    expect(ok('reverse', 'abc')).toBe('cba')
    expect(err('reverse', null).code).toBe('R019')
  })

  test('sort sorts numbers numerically and strings by code units, stably', () => {
    expect(shown('sort', makeList(10, 9, -1, 2))).toBe('[-1, 2, 9, 10]')
    expect(shown('sort', makeList('b', 'B', 'a', 'é'))).toBe('["B", "a", "b", "é"]')
    expect(shown('sort', makeList())).toBe('[]')
    const message = "'sort' can only sort a list of all numbers or all strings"
    expect(err('sort', makeList(1, 'a'))).toEqual({ code: 'R019', message })
    expect(err('sort', makeList(null))).toEqual({ code: 'R019', message })
    expect(err('sort', 'ab')).toEqual(r019('sort', 'a list', 1, 'a string'))
  })

  test('contains checks lists, strings, records and ranges', () => {
    expect(ok('contains', makeList(makeList(1)), makeList(1))).toBe(true)
    expect(ok('contains', makeList(1), 2)).toBe(false)
    expect(ok('contains', 'hello', 'ell')).toBe(true)
    expect(ok('contains', makeRecord({ a: 1 }), 'a')).toBe(true)
    expect(ok('contains', makeRecord({ a: 1 }), 1)).toBe(false)
    expect(ok('contains', makeRange(0, Infinity, 3), 3e9)).toBe(true)
    expect(ok('contains', makeRange(0, 10), 5.5)).toBe(false)
    expect(ok('contains', makeRange(0, 10), '5')).toBe(false)
    expect(err('contains', 'abc', 1)).toEqual(r019('contains', 'a string', 2, 'a number'))
    expect(err('contains', 1, 1)).toEqual(
      r019('contains', 'a list, string, record or range', 1, 'a number'),
    )
  })

  test('index_of finds equal items or substrings', () => {
    expect(ok('index_of', makeList(1, makeList(2)), makeList(2))).toBe(1)
    expect(ok('index_of', makeList(1), 5)).toBe(-1)
    expect(ok('index_of', 'abcabc', 'ca')).toBe(2)
    expect(err('index_of', 'abc', null)).toEqual(r019('index_of', 'a string', 2, 'nil'))
    expect(err('index_of', makeRecord({}), 1).code).toBe('R019')
  })

  test('join shows items with a separator', () => {
    expect(ok('join', makeList(1, 'a', makeList('b')))).toBe('1a["b"]')
    expect(ok('join', makeList(1, 2), ', ')).toBe('1, 2')
    expect(ok('join', makeList(), '-')).toBe('')
    expect(err('join', makeList(), null)).toEqual(r019('join', 'a string', 2, 'nil'))
    expect(err('join', 'ab')).toEqual(r019('join', 'a list', 1, 'a string'))
    const half = 'x'.repeat(SIZE_LIMIT / 2)
    expect(err('join', makeList(half, half), '-')).toEqual(TOO_LARGE)
    expect(err('join', makeList(half, half, 'y'))).toEqual(TOO_LARGE)
  })

  test('min and max take numbers or one list of numbers', () => {
    expect(ok('min', 3, 1, 2)).toBe(1)
    expect(ok('max', 3, 1, 2)).toBe(3)
    expect(ok('min', makeList(4, -2))).toBe(-2)
    expect(ok('max', 7)).toBe(7)
    expect(Number.isNaN(ok('max', 1, NaN, 2))).toBe(true)
    expect(Object.is(ok('min', 0, -0), -0)).toBe(true)
    expect(err('min', makeList())).toEqual({
      code: 'R019',
      message: "'min' expects a non-empty list",
    })
    expect(err('max', makeList(1, 'x'))).toEqual({
      code: 'R019',
      message: "'max' expects a list of numbers as argument 1, got a string",
    })
    expect(err('min', 1, makeList())).toEqual(r019('min', 'a number', 2, 'a list'))
  })

  test('copy makes shallow copies of lists and records', () => {
    const inner = makeList()
    const list = makeList(inner)
    const copied = ok('copy', list)
    expect(copied).not.toBe(list)
    expect(repr(copied)).toBe('[[]]')
    expect(shown('copy', makeRecord({ a: 1 }))).toBe('{a: 1}')
    expect(err('copy', makeClosure('f'))).toEqual(r019('copy', 'a list or record', 1, 'a function'))
  })
})

describe('string natives', () => {
  test('upper, lower and trim', () => {
    expect(ok('upper', 'ab ß')).toBe('AB SS')
    expect(ok('lower', 'ÀB')).toBe('àb')
    expect(ok('trim', ' \t a \n')).toBe('a')
    expect(err('upper', 1)).toEqual(r019('upper', 'a string', 1, 'a number'))
    expect(err('lower', null).code).toBe('R019')
    expect(err('trim', true).code).toBe('R019')
  })

  test('split follows JavaScript split', () => {
    expect(shown('split', 'a,b,,c', ',')).toBe('["a", "b", "", "c"]')
    expect(shown('split', 'abc', '')).toBe('["a", "b", "c"]')
    expect(shown('split', '', ',')).toBe('[""]')
    expect(err('split', 'a', 1)).toEqual(r019('split', 'a string', 2, 'a number'))
  })

  test('split refuses more than SIZE_LIMIT pieces', () => {
    const text = ','.repeat(SIZE_LIMIT)
    expect(err('split', text, ',')).toEqual(TOO_LARGE)
    expect(err('split', 'x'.repeat(SIZE_LIMIT + 1), '')).toEqual(TOO_LARGE)
  })

  test('replace replaces every occurrence literally', () => {
    expect(ok('replace', 'a.b.c', '.', '$&')).toBe('a$&b$&c')
    expect(ok('replace', 'abc', '', '-')).toBe('a-b-c')
    expect(err('replace', 'a', 'b', 1)).toEqual(r019('replace', 'a string', 3, 'a number'))
    expect(err('replace', 'x'.repeat(1 << 12), 'x', 'y'.repeat(1 << 13))).toEqual(TOO_LARGE)
  })

  test('starts_with and ends_with', () => {
    expect(ok('starts_with', 'hello', 'he')).toBe(true)
    expect(ok('ends_with', 'hello', 'he')).toBe(false)
    expect(err('ends_with', 'a', null)).toEqual(r019('ends_with', 'a string', 2, 'nil'))
  })

  test('repeat requires a non-negative integer count', () => {
    expect(ok('repeat', 'ab', 3)).toBe('ababab')
    expect(ok('repeat', '', 1e12)).toBe('')
    expect(ok('repeat', 'a', 0)).toBe('')
    const description = 'a non-negative integer'
    expect(err('repeat', 'a', -1)).toEqual(r019('repeat', description, 2, 'a number'))
    expect(err('repeat', 'a', 1.5)).toEqual(r019('repeat', description, 2, 'a number'))
    expect(err('repeat', 'a', '2')).toEqual(r019('repeat', description, 2, 'a string'))
    expect(err('repeat', 'ab', SIZE_LIMIT)).toEqual(TOO_LARGE)
  })

  test('chars splits into code units', () => {
    expect(shown('chars', 'a😀')).toBe(`["a", "${'\ud83d'}", "${'\ude00'}"]`)
    expect(err('chars', 1).code).toBe('R019')
  })

  test('char_code reads a code unit at an index (default 0)', () => {
    expect(ok('char_code', 'AB')).toBe(65)
    expect(ok('char_code', 'AB', -1)).toBe(66)
    expect(err('char_code', '', 0)).toEqual({
      code: 'R007',
      message: 'index 0 is out of bounds for a string of length 0',
    })
    expect(err('char_code', 'A', nil())).toEqual({
      code: 'R008',
      message: 'string index must be an integer, got nil',
    })
    expect(err('char_code', 1)).toEqual(r019('char_code', 'a string', 1, 'a number'))
  })

  test('from_char_code accepts integers from 0 to 65535', () => {
    expect(ok('from_char_code', 97)).toBe('a')
    const description = 'an integer from 0 to 65535'
    expect(err('from_char_code', 65536)).toEqual(r019('from_char_code', description, 1, 'a number'))
    expect(err('from_char_code', -1).code).toBe('R019')
    expect(err('from_char_code', 'a')).toEqual(r019('from_char_code', description, 1, 'a string'))
  })

  test('pad_start and pad_end follow JavaScript', () => {
    expect(ok('pad_start', '5', 3)).toBe('  5')
    expect(ok('pad_start', '5', 3, '0')).toBe('005')
    expect(ok('pad_end', 'ab', 5, 'xy')).toBe('abxyx')
    expect(ok('pad_end', 'abc', 2)).toBe('abc')
    expect(ok('pad_end', 'a', 3.9, '')).toBe('a')
    expect(ok('pad_start', 'a', NaN)).toBe('a')
    expect(err('pad_start', 'a', '3')).toEqual(r019('pad_start', 'a number', 2, 'a string'))
    expect(err('pad_end', 'a', 3, 0)).toEqual(r019('pad_end', 'a string', 3, 'a number'))
    expect(err('pad_end', 'a', SIZE_LIMIT + 1)).toEqual(TOO_LARGE)
    expect(ok('pad_end', 'a', 1e300, '')).toBe('a')
  })
})

function nil(): null {
  return null
}
