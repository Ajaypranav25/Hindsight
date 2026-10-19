import { describe, expect, test } from 'vitest'
import type { LocalView, ProvenanceEvent, StateView, ValueView } from '../../core/index'
import {
  changedTargets,
  consoleWindow,
  countBefore,
  currentEventIndex,
  eventLabel,
  formatRange,
  formatTraced,
  localsSummary,
  numericValues,
  sparkline,
  targetKey,
} from './panel-logic'
import { frameView, globalView, localView, stateView } from './test-fixtures'

const num = (value: number): ValueView => ({ kind: 'number', value })

function view(time: number, x: number, extra: readonly LocalView[] = []): StateView {
  return stateView({
    time,
    frames: [frameView({ uid: 1, locals: [localView('x', 1, num(x), 1), ...extra] })],
    globals: [globalView('g', num(0))],
  })
}

describe('targetKey', () => {
  test('distinguishes every target kind', () => {
    const keys = [
      targetKey({ kind: 'local', frameUid: 1, slot: 2 }),
      targetKey({ kind: 'global', name: 'x' }),
      targetKey({ kind: 'field', objectId: 1, key: 'a' }),
      targetKey({ kind: 'element', objectId: 1, index: 0 }),
      targetKey({ kind: 'object', objectId: 1 }),
      targetKey({ kind: 'cell', cellId: 1 }),
    ]
    expect(new Set(keys).size).toBe(6)
  })
})

describe('changedTargets', () => {
  test('reports a local whose value changed', () => {
    expect([...changedTargets(view(10, 1), view(11, 2))]).toEqual(['local:1:1'])
  })

  test('reports nothing when values are the same or there is no previous view', () => {
    expect(changedTargets(view(10, 1), view(11, 1)).size).toBe(0)
    expect(changedTargets(null, view(11, 1)).size).toBe(0)
  })

  test('reports nothing for big jumps', () => {
    expect(changedTargets(view(0, 1), view(501, 2)).size).toBe(0)
    expect(changedTargets(view(0, 1), view(500, 2)).size).toBe(1)
  })

  test('a new local in a live frame counts as changed; a whole new frame does not', () => {
    const y = localView('y', 2, num(5), 1)
    expect([...changedTargets(view(1, 1), view(2, 1, [y]))]).toEqual(['local:1:2'])
    const deeper = stateView({
      time: 3,
      frames: [...view(2, 1).frames, frameView({ uid: 7, locals: [localView('n', 1, num(3), 7)] })],
      globals: view(2, 1).globals,
    })
    expect(changedTargets(view(2, 1), deeper).size).toBe(0)
  })

  test('object values change when their preview changes', () => {
    const list = (preview: string): ValueView => ({ kind: 'ref', id: 4, type: 'list', preview })
    const a = stateView({ time: 1, globals: [globalView('xs', list('[1]'))] })
    const b = stateView({ time: 2, globals: [globalView('xs', list('[1, 2]'))] })
    expect([...changedTargets(a, b)]).toEqual(['global:xs'])
  })
})

describe('localsSummary', () => {
  test('shows the first two locals', () => {
    const locals = [
      localView('n', 1, num(3), 1),
      localView('s', 2, { kind: 'string', value: 'hi' }, 1),
    ]
    expect(localsSummary(locals)).toBe('n = 3, s = "hi"')
    expect(localsSummary([...locals, localView('z', 3, { kind: 'nil' }, 1)])).toBe(
      'n = 3, s = "hi", …',
    )
    expect(localsSummary([])).toBe('')
  })
})

describe('console window', () => {
  const outputs = Array.from({ length: 2000 }, (_, i) => ({ time: i * 10, text: `${i}` }))

  test('counts lines printed before the pen', () => {
    expect(countBefore(outputs, 0)).toBe(0)
    expect(countBefore(outputs, 1)).toBe(1)
    expect(countBefore(outputs, 10)).toBe(1)
    expect(countBefore(outputs, 100_000)).toBe(2000)
  })

  test('centres a window of lines on the pen and clamps at both ends', () => {
    expect(consoleWindow(outputs, 10_005)).toEqual({ start: 751, end: 1251, printed: 1001 })
    expect(consoleWindow(outputs, 0)).toEqual({ start: 0, end: 500, printed: 0 })
    expect(consoleWindow(outputs, 1e9)).toEqual({ start: 1500, end: 2000, printed: 2000 })
    expect(consoleWindow(outputs.slice(0, 3), 15)).toEqual({ start: 0, end: 3, printed: 2 })
  })
})

describe('history helpers', () => {
  const event = (time: number, value: ProvenanceEvent['value']): ProvenanceEvent => ({
    time,
    kind: 'write',
    target: { kind: 'global', name: 'x' },
    value,
  })

  test('formats traced values', () => {
    expect([null, true, 3, 'a"b', { ref: 9 }].map((v) => formatTraced(v))).toEqual([
      'nil',
      'true',
      '3',
      '"a\\"b"',
      'object #9',
    ])
  })

  test('labels events', () => {
    expect(eventLabel(event(1, 1))).toBe('set')
    expect(eventLabel({ ...event(1, 1), kind: 'list', op: 'insert', index: 2 })).toBe('insert at 2')
    expect(eventLabel({ ...event(1, 1), kind: 'alloc' })).toBe('create')
  })

  test('finds the event in effect at the pen', () => {
    const events = [event(5, 1), event(9, 2)]
    expect(currentEventIndex(events, 5)).toBe(-1)
    expect(currentEventIndex(events, 6)).toBe(0)
    expect(currentEventIndex(events, 100)).toBe(1)
  })

  test('numeric values only when every value is a finite number', () => {
    expect(numericValues([event(1, 1), event(2, 3)])).toEqual([1, 3])
    expect(numericValues([event(1, 1), event(2, 'x')])).toBeNull()
    expect(numericValues([event(1, 1)])).toBeNull()
  })

  test('sparkline geometry spans the box and puts the baseline at zero', () => {
    const line = sparkline([-1, 1, 0], 100, 20, 0)
    expect(line.line).toBe('0,20 50,0 100,10')
    expect(line.baseline).toBe(10)
    expect(line.area).toBe('0,10 0,20 50,0 100,10 100,10')
    expect(sparkline([4, 4], 10, 10, 0).baseline).toBe(10)
  })
})

test('formats ranges', () => {
  const range = { type: 'range', id: 1, start: 0, end: 10, step: 1, inclusive: false } as const
  expect(formatRange(range)).toBe('0..10')
  expect(formatRange({ ...range, inclusive: true, step: 2 })).toBe('0..=10 by 2')
})
