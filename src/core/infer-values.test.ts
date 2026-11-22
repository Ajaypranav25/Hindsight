import { describe, expect, test } from 'vitest'
import type { Recording } from './api-types'
import { compile, record } from './index'
import {
  type Plain,
  plainEquals,
  plainKey,
  plainLength,
  plainList,
  plainValue,
  roundHalfAway,
  sortableItems,
  typeName,
  uniqueItems,
} from './infer-values'

function recorded(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => d.message).join('; '))
  return record(compiled.program, {})
}

/** The value of global `name` at the end of the run, as plain data. */
function globalValue(source: string, name: string): Plain {
  const recording = recorded(source)
  const t = recording.length
  const global = recording.stateAt(t).globals.find((g) => g.name === name)
  if (global === undefined) throw new Error(`no global ${name}`)
  return plainValue(recording, t, global.value)
}

describe('plainValue', () => {
  test('reads nested lists and records in full', () => {
    // Arrange / Act
    const value = globalValue('let v = [1, "a", {k: [true, nil]}]', 'v')

    // Assert
    expect(plainKey(value)).toBe('[1,"a",{"k":[true,null]}]')
    expect(typeName(value)).toBe('list')
  })

  test('keeps only the length of a long list and cuts a cycle', () => {
    // Arrange / Act
    const long = globalValue('let v = list(0..300)', 'v')
    const cyclic = globalValue('let v = [1]\npush(v, v)', 'v')

    // Assert
    expect(plainKey(long)).toBe('[…300]')
    expect(plainLength(long)).toBe(300)
    expect(plainKey(cyclic)).toBe('[1,[…2]]')
  })

  test('keeps only the type of functions and ranges', () => {
    // Arrange / Act
    const fn = globalValue('fn f() { 1 }\nlet v = f', 'v')
    const builtin = globalValue('let v = len', 'v')
    const range = globalValue('let v = 0..3', 'v')

    // Assert
    expect(typeName(fn)).toBe('function')
    expect(typeName(builtin)).toBe('function')
    expect(typeName(range)).toBe('range')
    expect(plainKey(range)).toBe('<range>')
    expect(plainLength(fn)).toBeNull()
  })

  test('cuts records nested too deep', () => {
    // Arrange / Act
    const value = globalValue('let v = {a: {b: {c: {d: {e: 1}}}}}', 'v')

    // Assert
    expect(plainKey(value)).toBe('{"a":{"b":{"c":{"d":{…1}}}}}')
  })
})

describe('plainEquals', () => {
  test('compares like == on plain data', () => {
    // Arrange
    const a = globalValue('let v = {x: [1, 2], y: "s"}', 'v')
    const b = globalValue('let v = {y: "s", x: [1, 2]}', 'v')
    const c = globalValue('let v = {x: [1, 3], y: "s"}', 'v')
    const d = globalValue('let v = {x: [1, 2], z: "s"}', 'v')

    // Act / Assert
    expect(plainEquals(a, b)).toBe(true)
    expect(plainEquals(a, c)).toBe(false)
    expect(plainEquals(a, d)).toBe(false)
    expect(plainEquals(plainList([1]), plainList([1, 2]))).toBe(false)
    expect(plainEquals(1, '1')).toBe(false)
    expect(plainEquals(plainList([]), a)).toBe(false)
  })

  test('cannot tell when contents were not read', () => {
    // Arrange
    const range = globalValue('let v = 0..3', 'v')
    const long = globalValue('let v = list(0..300)', 'v')
    const deep = globalValue('let v = {a: {b: {c: {d: {e: 1}}}}}', 'v')

    // Act / Assert
    expect(plainEquals(range, range)).toBeNull()
    expect(plainEquals(long, long)).toBeNull()
    expect(plainEquals(deep, deep)).toBeNull()
  })
})

describe('builtins on plain data', () => {
  test('uniq keeps first occurrences and gives up on undecidable items', () => {
    // Arrange
    const range = globalValue('let v = 0..3', 'v')

    // Act / Assert
    expect(uniqueItems([1, 2, 1, 3, 2])).toEqual([1, 2, 3])
    expect(uniqueItems([range, range])).toBeNull()
  })

  test('sort takes all numbers or all strings only', () => {
    // Arrange / Act / Assert
    expect(sortableItems(plainList([3, 1]))).toEqual([3, 1])
    expect(sortableItems(plainList(['b', 'a']))).toEqual(['b', 'a'])
    expect(sortableItems(plainList([1, 'a']))).toBeNull()
    expect(sortableItems(plainList([Number.NaN]))).toBeNull()
    expect(sortableItems('ab')).toBeNull()
  })

  test('round takes halves away from zero', () => {
    // Arrange / Act / Assert
    expect(roundHalfAway(2.5)).toBe(3)
    expect(roundHalfAway(-2.5)).toBe(-3)
    expect(roundHalfAway(-2.4)).toBe(-2)
  })

  test('names the types as type() does', () => {
    // Arrange / Act / Assert
    expect(typeName(null)).toBe('nil')
    expect(typeName(true)).toBe('bool')
    expect(typeName('s')).toBe('string')
    expect(typeName({ kind: 'other', type: 'iterator' })).toBeNull()
    expect(plainKey(null)).toBe('null')
    expect(plainKey(true)).toBe('true')
  })
})
