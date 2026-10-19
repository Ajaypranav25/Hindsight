import { describe, expect, test } from 'vitest'
import { NATIVE_NAMES } from './builtin-names'
import { createNatives } from './natives'
import { roundHalfAwayFromZero } from './natives-math'
import type { NativeObj, Value } from './runtime-types'
import { makeList, makeRange, makeRecord } from './testing/fixtures'
import { err, ok, r019, shown } from './testing/native-checks'
import { callNativeOn, nativeMachine } from './testing/vm-harness'
import { SIZE_LIMIT, repr } from './values'

describe('the native table', () => {
  test('natives come in NATIVE_NAMES order with ids -(index + 1)', () => {
    const natives = createNatives()
    expect(natives).toHaveLength(NATIVE_NAMES.length)
    natives.forEach((value, index) => {
      const name = NATIVE_NAMES[index]!
      if (name === 'PI') expect(value).toBe(Math.PI)
      else if (name === 'INF') expect(value).toBe(Infinity)
      else expect(value).toMatchObject({ type: 'native', id: -(index + 1), name })
    })
  })

  test.each([
    ['print', 0, Infinity],
    ['range', 1, 3],
    ['assert', 1, 2],
    ['insert', 3, 3],
    ['slice', 2, 3],
    ['join', 1, 2],
    ['min', 1, Infinity],
    ['get', 2, 3],
    ['char_code', 1, 2],
    ['pad_end', 2, 3],
    ['random', 0, 0],
    ['steps', 0, 0],
  ])('%s takes %i to %s arguments', (name, min, max) => {
    const native = createNatives()[NATIVE_NAMES.indexOf(name as never)] as NativeObj
    expect([native.minArgs, native.maxArgs]).toEqual([min, max])
  })
})

describe('output and conversion natives', () => {
  test('print emits one line of shown values joined by spaces', () => {
    const lines: string[] = []
    const machine = nativeMachine()
    machine.hooks = {
      output: (_time, text) => lines.push(text),
      write: () => undefined,
      listOp: () => undefined,
      fieldDelete: () => undefined,
      alloc: () => undefined,
      cellClosed: () => undefined,
    }
    expect(callNativeOn(machine, 'print', 'a', 1, makeList('b'), null)).toMatchObject({
      value: null,
    })
    callNativeOn(machine, 'print')
    expect(lines).toEqual(['a 1 ["b"] nil', ''])
  })

  test('print, str and repr raise R025 for results over the size limit', () => {
    const big = 'x'.repeat(SIZE_LIMIT)
    expect(err('print', big, 'y')).toEqual({ code: 'R025', message: 'result too large' })
    expect(ok('str', big)).toBe(big)
    expect(err('repr', big).code).toBe('R025')
    expect(err('str', makeList(big, big)).code).toBe('R025')
  })

  test('str shows and repr quotes', () => {
    expect(ok('str', 'a"b')).toBe('a"b')
    expect(ok('repr', 'a"b\n')).toBe('"a\\"b\\n"')
    expect(ok('str', -0)).toBe('0')
    expect(ok('str', makeRange(0, 10, 2))).toBe('range(0, 10, 2)')
  })

  test('type names every value type', () => {
    const values: Value[] = [null, true, 1, 's', makeList(), makeRecord({}), makeRange(0, 1)]
    expect(values.map((v) => ok('type', v))).toEqual([
      'nil',
      'bool',
      'number',
      'string',
      'list',
      'record',
      'range',
    ])
    expect(ok('type', createNatives()[0]!)).toBe('function')
  })

  test('len counts items, code units, keys and range elements', () => {
    expect(ok('len', makeList(1, 2))).toBe(2)
    expect(ok('len', 'abc')).toBe(3)
    expect(ok('len', makeRecord({ a: 1 }))).toBe(1)
    expect(ok('len', makeRange(0, Infinity))).toBe(Infinity)
    expect(ok('len', makeRange(0, 10, 3))).toBe(4)
    expect(err('len', 5)).toEqual(r019('len', 'a list, string, record or range', 1, 'a number'))
  })

  test('num converts trimmed strings and returns nil for non-numbers', () => {
    expect(ok('num', 4)).toBe(4)
    expect(ok('num', ' 42 ')).toBe(42)
    expect(ok('num', '1e3')).toBe(1000)
    expect(ok('num', '0x1F')).toBe(31)
    expect(ok('num', 'Infinity')).toBe(Infinity)
    expect(ok('num', '  ')).toBeNull()
    expect(ok('num', '12abc')).toBeNull()
    expect(err('num', null)).toEqual(r019('num', 'a number or string', 1, 'nil'))
  })

  test('list collects the elements of any iterable', () => {
    expect(shown('list', 'ab')).toBe('["a", "b"]')
    expect(shown('list', makeRange(1, 3, 1, true))).toBe('[1, 2, 3]')
    expect(shown('list', makeRecord({ x: 1, y: 2 }))).toBe('["x", "y"]')
    const source = makeList(1)
    const copy = ok('list', source)
    expect(copy).not.toBe(source)
    expect(err('list', 1)).toEqual({ code: 'R013', message: 'cannot iterate over a number' })
    expect(err('list', makeRange(0, Infinity))).toEqual({
      code: 'R025',
      message: 'result too large',
    })
  })

  test('range builds ranges and checks each argument', () => {
    expect(shown('range', 5)).toBe('0..5')
    expect(shown('range', 2, 5)).toBe('2..5')
    expect(shown('range', 0, 10, 2)).toBe('range(0, 10, 2)')
    expect(err('range', 0, 'x')).toEqual(r019('range', 'a number', 2, 'a string'))
    expect(err('range', 0, 1, 0)).toEqual({ code: 'R021', message: 'range step cannot be zero' })
    expect(err('range', 'a', 1, 0).code).toBe('R019')
  })

  test('assert passes on truthy values and reports R018 otherwise', () => {
    expect(ok('assert', 0)).toBeNull()
    expect(err('assert', false)).toEqual({ code: 'R018', message: 'assertion failed' })
    expect(err('assert', null, 'boom')).toEqual({ code: 'R018', message: 'assertion failed: boom' })
    expect(err('assert', false, null)).toEqual({ code: 'R018', message: 'assertion failed: nil' })
  })

  test('panic raises R017 with the shown message', () => {
    expect(err('panic', 'stop')).toEqual({ code: 'R017', message: 'stop' })
    expect(err('panic', makeList(1))).toEqual({ code: 'R017', message: '[1]' })
  })

  test('steps returns the executing step', () => {
    const machine = nativeMachine()
    machine.time = 17
    expect(callNativeOn(machine, 'steps')).toMatchObject({ value: 17 })
  })
})

describe('record natives', () => {
  const rec = (): Value => makeRecord({ a: 1, 'b c': 2 })

  test('keys, values and entries in insertion order', () => {
    expect(shown('keys', rec())).toBe('["a", "b c"]')
    expect(shown('values', rec())).toBe('[1, 2]')
    expect(shown('entries', rec())).toBe('[["a", 1], ["b c", 2]]')
    expect(err('keys', makeList())).toEqual(r019('keys', 'a record', 1, 'a list'))
    expect(err('values', 1).code).toBe('R019')
    expect(err('entries', 1).code).toBe('R019')
  })

  test('has and get look up string keys', () => {
    expect(ok('has', rec(), 'a')).toBe(true)
    expect(ok('has', rec(), 'z')).toBe(false)
    expect(ok('get', rec(), 'b c')).toBe(2)
    expect(ok('get', rec(), 'z')).toBeNull()
    expect(ok('get', rec(), 'z', 0)).toBe(0)
    expect(err('has', rec(), 1)).toEqual(r019('has', 'a string', 2, 'a number'))
    expect(err('get', 1, 'a')).toEqual(r019('get', 'a record', 1, 'a number'))
  })

  test('delete removes a key and returns its old value', () => {
    const record = rec()
    expect(ok('delete', record, 'a')).toBe(1)
    expect(ok('delete', record, 'a')).toBeNull()
    expect(repr(record)).toBe('{"b c": 2}')
    expect(err('delete', record, null)).toEqual(r019('delete', 'a string', 2, 'nil'))
  })
})

describe('math natives', () => {
  test('unary functions follow Math', () => {
    expect(ok('abs', -3)).toBe(3)
    expect(ok('floor', -1.5)).toBe(-2)
    expect(ok('ceil', 1.2)).toBe(2)
    expect(ok('sqrt', 9)).toBe(3)
    expect(ok('sin', 0)).toBe(0)
    expect(ok('cos', 0)).toBe(1)
    expect(ok('log', 1)).toBe(0)
    expect(ok('atan2', 0, 1)).toBe(0)
    for (const name of ['abs', 'floor', 'ceil', 'sqrt', 'sin', 'cos', 'log', 'round']) {
      expect(err(name, 'x')).toEqual(r019(name, 'a number', 1, 'a string'))
    }
    expect(err('atan2', 1, true)).toEqual(r019('atan2', 'a number', 2, 'a bool'))
  })

  test('round takes halves away from zero', () => {
    expect([2.5, -2.5, 0.5, -0.5, 1.4, -1.6].map((x) => ok('round', x))).toEqual([
      3, -3, 1, -1, 1, -2,
    ])
    expect(roundHalfAwayFromZero(Infinity)).toBe(Infinity)
    expect(Number.isNaN(roundHalfAwayFromZero(NaN))).toBe(true)
  })

  test('random_int checks integers and order', () => {
    const value = ok('random_int', 1, 1)
    expect(value).toBe(1)
    expect(err('random_int', 1.5, 2)).toEqual(r019('random_int', 'an integer', 1, 'a number'))
    expect(err('random_int', 1, '2')).toEqual(r019('random_int', 'an integer', 2, 'a string'))
    expect(err('random_int', 3, 2)).toEqual({
      code: 'R019',
      message: "'random_int' expects lo <= hi",
    })
  })

  test('random draws from [0, 1) and seed checks its argument', () => {
    const value = ok('random') as number
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThan(1)
    expect(ok('seed', 3)).toBeNull()
    expect(err('seed', 'x')).toEqual(r019('seed', 'a number', 1, 'a string'))
  })
})
