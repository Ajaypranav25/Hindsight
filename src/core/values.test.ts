import { describe, expect, test } from 'vitest'
import type { CellObj, IteratorObj, Value } from './runtime-types'
import {
  deepList,
  makeClosure,
  makeList,
  makeNative,
  makeRange,
  makeRecord,
} from './testing/fixtures'
import {
  SIZE_LIMIT,
  articleType,
  equals,
  isBuiltinValue,
  isCallable,
  isHeapObject,
  isList,
  isRange,
  isRecord,
  isTruthy,
  typeName,
} from './values'

const cell: CellObj = {
  type: 'cell',
  id: 7,
  open: false,
  stackIndex: 0,
  value: null,
  ownerFrameUid: 1,
  slot: 1,
}
const iterator: IteratorObj = {
  type: 'iterator',
  id: 8,
  source: 'abc',
  position: 0,
  keys: null,
}

describe('typeName and articleType', () => {
  const cases: [Value, string, string][] = [
    [null, 'nil', 'nil'],
    [true, 'bool', 'a bool'],
    [false, 'bool', 'a bool'],
    [0, 'number', 'a number'],
    [Number.NaN, 'number', 'a number'],
    ['', 'string', 'a string'],
    [makeList(), 'list', 'a list'],
    [makeRecord({}), 'record', 'a record'],
    [makeClosure('f'), 'function', 'a function'],
    [makeClosure('map', -60), 'function', 'a function'],
    [makeNative('print'), 'function', 'a function'],
    [makeRange(0, 1), 'range', 'a range'],
  ]

  test.each(cases)('%o has type %s and article type %s', (value, type, article) => {
    expect(typeName(value)).toBe(type)
    expect(articleType(value)).toBe(article)
  })

  test('internal objects are not language values', () => {
    expect(() => typeName(cell)).toThrow(/internal error/)
    expect(() => articleType(iterator)).toThrow(/internal error/)
  })
})

describe('isTruthy', () => {
  test('only nil and false are falsy', () => {
    expect(isTruthy(null)).toBe(false)
    expect(isTruthy(false)).toBe(false)
    for (const value of [true, 0, -0, Number.NaN, '', makeList(), makeRecord({})]) {
      expect(isTruthy(value)).toBe(true)
    }
  })
})

describe('type guards', () => {
  test('classify heap objects', () => {
    const list = makeList()
    const record = makeRecord({})
    const range = makeRange(0, 1)
    expect(isHeapObject(list)).toBe(true)
    expect(isHeapObject('x')).toBe(false)
    expect(isHeapObject(null)).toBe(false)
    expect(isList(list)).toBe(true)
    expect(isList(record)).toBe(false)
    expect(isRecord(record)).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRange(range)).toBe(true)
    expect(isRange(3)).toBe(false)
    expect(isCallable(makeNative('len'))).toBe(true)
    expect(isCallable(makeClosure('f'))).toBe(true)
    expect(isCallable(list)).toBe(false)
  })

  test('builtins are natives and negative-id closures', () => {
    expect(isBuiltinValue(makeNative('len'))).toBe(true)
    expect(isBuiltinValue(makeClosure('map', -58))).toBe(true)
    expect(isBuiltinValue(makeClosure('f', 5))).toBe(false)
    expect(isBuiltinValue(5)).toBe(false)
  })

  test('the size limit is 2^24', () => {
    expect(SIZE_LIMIT).toBe(16_777_216)
  })
})

describe('equals (SPEC §7.4)', () => {
  test('primitives compare by value; numbers by ===', () => {
    expect(equals(null, null)).toBe(true)
    expect(equals(true, true)).toBe(true)
    expect(equals(true, false)).toBe(false)
    expect(equals('a', 'a')).toBe(true)
    expect(equals('a', 'b')).toBe(false)
    expect(equals(0, -0)).toBe(true)
    expect(equals(Number.NaN, Number.NaN)).toBe(false)
    expect(equals(Infinity, Infinity)).toBe(true)
  })

  test('different types are never equal', () => {
    expect(equals(1, '1')).toBe(false)
    expect(equals(null, false)).toBe(false)
    expect(equals(makeList(), makeRecord({}))).toBe(false)
    expect(equals(makeList(), null)).toBe(false)
    expect(equals(0, makeList())).toBe(false)
    expect(equals(makeRange(0, 1), makeList(0))).toBe(false)
  })

  test('the same object equals itself before its contents are examined', () => {
    const withNaN = makeList(Number.NaN)
    expect(equals(withNaN, withNaN)).toBe(true)
    expect(equals(withNaN, makeList(Number.NaN))).toBe(false)
  })

  test('lists compare by length and items', () => {
    expect(equals(makeList(1, 'a', makeList(null)), makeList(1, 'a', makeList(null)))).toBe(true)
    expect(equals(makeList(1, 2), makeList(1, 2, 3))).toBe(false)
    expect(equals(makeList(1, 2), makeList(1, 3))).toBe(false)
    expect(equals(makeList(makeList(1)), makeList(makeList('1')))).toBe(false)
  })

  test('records compare key sets and values, ignoring order', () => {
    const a = makeRecord([
      ['x', 1],
      ['y', makeList(2)],
    ])
    const b = makeRecord([
      ['y', makeList(2)],
      ['x', 1],
    ])
    expect(equals(a, b)).toBe(true)
    expect(equals(a, makeRecord({ x: 1, z: makeList(2) }))).toBe(false)
    expect(equals(a, makeRecord({ x: 1 }))).toBe(false)
    expect(equals(a, makeRecord({ x: 1, y: makeList(3) }))).toBe(false)
  })

  test('ranges compare start, end, step and inclusivity', () => {
    expect(equals(makeRange(0, 5), makeRange(0, 5))).toBe(true)
    expect(equals(makeRange(0, 5), makeRange(0, 5, 1, true))).toBe(false)
    expect(equals(makeRange(0, 6, 2), makeRange(0, 6, 3))).toBe(false)
    expect(equals(makeRange(1, 5), makeRange(0, 5))).toBe(false)
    expect(equals(makeRange(0, 4), makeRange(0, 5))).toBe(false)
  })

  test('functions are equal only to themselves', () => {
    const f = makeClosure('f')
    const g = makeClosure('f')
    const n = makeNative('len')
    expect(equals(f, f)).toBe(true)
    expect(equals(f, g)).toBe(false)
    expect(equals(n, n)).toBe(true)
    expect(equals(n, makeNative('len'))).toBe(false)
    expect(equals(makeList(f), makeList(g))).toBe(false)
  })

  test('cyclic structures compare without looping', () => {
    const a = makeList(1)
    a.items.push(a)
    const b = makeList(1)
    b.items.push(b)
    const c = makeList(2)
    c.items.push(c)
    expect(equals(a, b)).toBe(true)
    expect(equals(a, c)).toBe(false)

    const r = makeRecord({ n: 1 })
    r.fields.set('self', r)
    const s = makeRecord({ n: 1 })
    s.fields.set('self', s)
    expect(equals(r, s)).toBe(true)
  })

  test('mutually recursive structures compare structurally', () => {
    const a1 = makeList()
    const a2 = makeList(a1)
    a1.items.push(a2)
    const b1 = makeList()
    b1.items.push(b1)
    expect(equals(a1, b1)).toBe(true)
  })

  test('shared references are compared per position', () => {
    const shared = makeList(1)
    expect(equals(makeList(shared, shared), makeList(makeList(1), makeList(1)))).toBe(true)
    expect(equals(makeList(shared, shared), makeList(makeList(1), makeList(2)))).toBe(false)
  })

  test('100,000-deep lists compare without recursion', () => {
    expect(equals(deepList(100_000, [1]), deepList(100_000, [1]))).toBe(true)
    expect(equals(deepList(100_000, [1]), deepList(100_000, [2]))).toBe(false)
  })
})
