import { describe, expect, test } from 'vitest'
import { makeList, makeRange, makeRecord } from './testing/fixtures'
import {
  collectElements,
  elementCount,
  isIterable,
  rangeAccepts,
  rangeContains,
  rangeElement,
  rangeLength,
} from './values'

/** Elements by iterating the definition directly (only for small ranges). */
function iterateRange(start: number, end: number, step: number, inclusive = false): number[] {
  const range = makeRange(start, end, step, inclusive)
  const out: number[] = []
  for (let k = 0; k < 1_000_000; k++) {
    const element = rangeElement(range, k)
    if (!rangeAccepts(range, element)) break
    out.push(element)
  }
  return out
}

describe('range elements (SPEC §7.6)', () => {
  test('element k is start + k * step, never repeated addition', () => {
    const range = makeRange(0, 1, 0.1)
    expect(rangeElement(range, 3)).toBe(3 * 0.1)
    expect(rangeElement(range, 10)).toBe(1)
    expect(iterateRange(0, 1, 0.1)).toHaveLength(10)
  })

  test('bound tests by direction and inclusivity', () => {
    expect(iterateRange(0, 5, 1)).toEqual([0, 1, 2, 3, 4])
    expect(iterateRange(0, 5, 1, true)).toEqual([0, 1, 2, 3, 4, 5])
    expect(iterateRange(10, 0, -3)).toEqual([10, 7, 4, 1])
    expect(iterateRange(3, 0, -1, true)).toEqual([3, 2, 1, 0])
    expect(iterateRange(5, 0, 1)).toEqual([])
    expect(iterateRange(0, 5, -1)).toEqual([])
  })

  test('NaN anywhere means no elements', () => {
    expect(rangeAccepts(makeRange(0, 5, Number.NaN), 0)).toBe(false)
    expect(iterateRange(Number.NaN, 5, 1)).toEqual([])
    expect(iterateRange(0, Number.NaN, 1)).toEqual([])
  })
})

describe('rangeLength', () => {
  const cases: [string, number, number, number, boolean, number][] = [
    ['0..5', 0, 5, 1, false, 5],
    ['0..=5', 0, 5, 1, true, 6],
    ['5..0', 5, 0, 1, false, 0],
    ['0..0', 0, 0, 1, false, 0],
    ['0..=0', 0, 0, 1, true, 1],
    ['0.5..3', 0.5, 3, 1, false, 3],
    ['range(10, 0, -2)', 10, 0, -2, false, 5],
    ['range(0, 10, -1)', 0, 10, -1, false, 0],
    ['range(0, 1, 0.1)', 0, 1, 0.1, false, 10],
    ['range(0, 10, 3)', 0, 10, 3, false, 4],
    ['0..INF', 0, Infinity, 1, false, Infinity],
    ['-INF..0', -Infinity, 0, 1, false, Infinity],
    ['-INF..-INF', -Infinity, -Infinity, 1, false, 0],
    ['INF..INF', Infinity, Infinity, 1, false, 0],
    ['INF..=INF', Infinity, Infinity, 1, true, Infinity],
    ['range(0, -INF, -1)', 0, -Infinity, -1, false, Infinity],
    ['range(INF, 0, -1)', Infinity, 0, -1, false, Infinity],
    ['range(0, 10, INF)', 0, 10, Infinity, false, 0],
    ['NaN..5', Number.NaN, 5, 1, false, 0],
    ['0..NaN', 0, Number.NaN, 1, false, 0],
    ['range(0, 5, NaN)', 0, 5, Number.NaN, false, 0],
    ['0..1e300', 0, 1e300, 1, false, 1e300],
  ]

  test.each(cases)('len(%s) is %d', (_label, start, end, step, inclusive, expected) => {
    expect(rangeLength(makeRange(start, end, step, inclusive))).toBe(expected)
  })

  test('matches iteration where elements repeat because of rounding', () => {
    const start = 1e17
    for (const [end, step] of [
      [1e17 + 16, 1],
      [1e17 + 64, 0.25],
      [1e17 + 40, 3],
    ] as const) {
      expect(rangeLength(makeRange(start, end, step))).toBe(iterateRange(start, end, step).length)
    }
  })

  test('matches iteration for many fractional steps', () => {
    for (const step of [0.1, 0.2, 0.3, 0.7, 1.1, 2.5]) {
      for (const end of [1, 2.2, 3.3, 7, 10.5]) {
        expect(rangeLength(makeRange(0, end, step))).toBe(iterateRange(0, end, step).length)
        expect(rangeLength(makeRange(end, 0, -step))).toBe(iterateRange(end, 0, -step).length)
      }
    }
  })
})

describe('rangeContains', () => {
  test('integers in simple ranges', () => {
    const range = makeRange(0, 10)
    expect(rangeContains(range, 5)).toBe(true)
    expect(rangeContains(range, 0)).toBe(true)
    expect(rangeContains(range, -0)).toBe(true)
    expect(rangeContains(range, 10)).toBe(false)
    expect(rangeContains(range, -1)).toBe(false)
    expect(rangeContains(range, 5.5)).toBe(false)
    expect(rangeContains(makeRange(0, 10, 1, true), 10)).toBe(true)
  })

  test('non-numbers and NaN are never contained', () => {
    expect(rangeContains(makeRange(0, 10), '5')).toBe(false)
    expect(rangeContains(makeRange(0, 10), null)).toBe(false)
    expect(rangeContains(makeRange(0, 10), Number.NaN)).toBe(false)
    expect(rangeContains(makeRange(5, 0), 3)).toBe(false)
  })

  test('steps and negative steps', () => {
    const down = makeRange(10, 0, -2)
    expect(rangeContains(down, 4)).toBe(true)
    expect(rangeContains(down, 10)).toBe(true)
    expect(rangeContains(down, 5)).toBe(false)
    expect(rangeContains(down, 0)).toBe(false)
    expect(rangeContains(down, 12)).toBe(false)
    const fractional = makeRange(0, 1, 0.1)
    expect(rangeContains(fractional, 3 * 0.1)).toBe(true)
    expect(rangeContains(fractional, 0.3)).toBe(false)
    expect(rangeContains(fractional, 1)).toBe(false)
  })

  test('unbounded ranges terminate', () => {
    const up = makeRange(0, Infinity)
    expect(rangeContains(up, 1e300)).toBe(true)
    expect(rangeContains(up, 123456)).toBe(true)
    expect(rangeContains(up, 0.5)).toBe(false)
    expect(rangeContains(up, Infinity)).toBe(false)
    expect(rangeContains(up, -1)).toBe(false)
    const flat = makeRange(-Infinity, 0)
    expect(rangeContains(flat, -Infinity)).toBe(true)
    expect(rangeContains(flat, -5)).toBe(false)
    const down = makeRange(0, -Infinity, -0.5)
    expect(rangeContains(down, -1e6)).toBe(true)
    expect(rangeContains(down, -0.25)).toBe(false)
  })

  test('agrees with iteration on rounding plateaus', () => {
    const range = makeRange(1e17, 1e17 + 64, 0.25)
    const elements = iterateRange(1e17, 1e17 + 64, 0.25)
    for (const candidate of [1e17, 1e17 + 16, 1e17 + 32, 1e17 + 48, 1e17 + 64]) {
      expect(rangeContains(range, candidate)).toBe(elements.includes(candidate))
    }
  })
})

describe('iteration helpers', () => {
  test('isIterable accepts lists, ranges, strings and records', () => {
    expect(isIterable(makeList())).toBe(true)
    expect(isIterable(makeRange(0, 1))).toBe(true)
    expect(isIterable('')).toBe(true)
    expect(isIterable(makeRecord({}))).toBe(true)
    expect(isIterable(null)).toBe(false)
    expect(isIterable(5)).toBe(false)
    expect(isIterable(true)).toBe(false)
  })

  test('elementCount counts without iterating', () => {
    expect(elementCount(makeList(1, 2))).toBe(2)
    expect(elementCount('abc')).toBe(3)
    expect(elementCount(makeRecord({ a: 1 }))).toBe(1)
    expect(elementCount(makeRange(0, Infinity))).toBe(Infinity)
  })

  test('collectElements yields items, elements, code units and keys', () => {
    const list = makeList(1, 2)
    const copy = collectElements(list)
    expect(copy).toEqual([1, 2])
    expect(copy).not.toBe(list.items)
    expect(collectElements(makeRange(3, 0, -1))).toEqual([3, 2, 1])
    expect(collectElements('a😀')).toEqual(['a', '\ud83d', '\ude00'])
    expect(collectElements(makeRecord({ b: 1, a: 2 }))).toEqual(['b', 'a'])
  })
})
