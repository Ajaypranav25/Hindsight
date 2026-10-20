import { describe, expect, test } from 'vitest'
import type { ProvenanceEvent, Recording, WriteTarget } from './api-types'
import { InternalError } from './diagnostics'
import { recordSource } from './testing/recording'

/** The statement line of the step that performed `event`. */
function lineOf(recording: Recording, event: ProvenanceEvent | null): number | null {
  return event === null ? null : (recording.locationAt(event.time)?.stmtLine ?? null)
}

/** The first time a statement on `line` starts (user code). */
function firstHit(recording: Recording, line: number, occurrence = 0): number {
  const time = recording.lineHits(line)[occurrence]
  if (time === undefined) throw new Error(`line ${line} never ran`)
  return time
}

function localTarget(recording: Recording, t: number, name: string): WriteTarget {
  const frame = recording.stateAt(t).frames.at(-1)
  const local = frame?.locals.find((candidate) => candidate.name === name)
  if (local === undefined) throw new Error(`no live local ${name} at ${t}`)
  return local.target
}

function refId(recording: Recording, t: number, globalName: string): number {
  const value = recording.stateAt(t).globals.find((g) => g.name === globalName)?.value
  if (value?.kind !== 'ref') throw new Error(`${globalName} is not an object`)
  return value.id
}

const LISTS = `let xs = [10, 20]
push(xs, 30)
insert(xs, 0, 5)
xs[1] = 11
remove(xs, 0)
pop(xs)
let zs = [0, ...xs]
print(xs)`

describe('origin of list elements', () => {
  const recording = recordSource(LISTS)
  const end = recording.length
  const xs = refId(recording, end, 'xs')
  const zs = refId(recording, end, 'zs')

  test('the run ends with the expected list', () => {
    expect(recording.outputs.map((o) => o.text)).toEqual(['[11, 20]'])
  })

  test('an index write survives a later remove before it (index translation)', () => {
    const event = recording.origin({ kind: 'element', objectId: xs, index: 0 }, end)
    expect(event).toMatchObject({ kind: 'write', value: 11, target: { kind: 'element', index: 1 } })
    expect(lineOf(recording, event)).toBe(4)
  })

  test('an element from the literal goes back to the allocation through insert and remove', () => {
    const event = recording.origin({ kind: 'element', objectId: xs, index: 1 }, end)
    expect(event).toMatchObject({ kind: 'alloc', value: { ref: xs } })
    expect(lineOf(recording, event)).toBe(1)
  })

  test('an appended element (before the pop removes it)', () => {
    const event = recording.origin(
      { kind: 'element', objectId: xs, index: 2 },
      firstHit(recording, 6),
    )
    expect(event).toMatchObject({ kind: 'list', op: 'append', index: 2, count: 1, value: 30 })
  })

  test('an inserted element', () => {
    const event = recording.origin(
      { kind: 'element', objectId: xs, index: 0 },
      firstHit(recording, 4),
    )
    expect(event).toMatchObject({ kind: 'list', op: 'insert', index: 0, value: 5 })
  })

  test('elements added by a spread come from the extend event', () => {
    const extended = recording.origin({ kind: 'element', objectId: zs, index: 2 }, end)
    expect(extended).toMatchObject({
      kind: 'list',
      op: 'extend',
      index: 1,
      count: 2,
      value: { ref: xs },
    })
    const first = recording.origin({ kind: 'element', objectId: zs, index: 0 }, end)
    expect(first?.kind).toBe('alloc')
  })

  test('the whole object: the latest event of any kind', () => {
    const event = recording.origin({ kind: 'object', objectId: xs }, end)
    expect(event).toMatchObject({ kind: 'list', op: 'pop', index: 2, value: 30 })
    expect(recording.origin({ kind: 'object', objectId: xs }, 0)).toBeNull()
  })

  test('element history follows the element through shape changes', () => {
    const result = recording.history({ kind: 'element', objectId: xs, index: 0 }, end)
    expect(result.events.map((e) => [e.kind, lineOf(recording, e)])).toEqual([
      ['alloc', 1],
      ['write', 4],
    ])
    expect(result.total).toBe(2)
    expect(result.truncated).toBe(false)
  })

  test('element history includes later writes to the same element', () => {
    const at = firstHit(recording, 3)
    const result = recording.history({ kind: 'element', objectId: xs, index: 0 }, at)
    expect(result.events.map((e) => [e.kind, lineOf(recording, e)])).toEqual([
      ['alloc', 1],
      ['write', 4],
    ])
  })
})

const RECORDS = `let r = {a: 1}
r.a = 2
r.b = 3
delete(r, "a")
print(r)`

describe('origin of fields', () => {
  const recording = recordSource(RECORDS)
  const end = recording.length
  const r = refId(recording, end, 'r')

  test('the latest write or delete of the key', () => {
    const deleted = recording.origin({ kind: 'field', objectId: r, key: 'a' }, end)
    expect(deleted).toMatchObject({
      kind: 'delete',
      value: null,
      target: { kind: 'field', key: 'a' },
    })
    expect(lineOf(recording, deleted)).toBe(4)
    const written = recording.origin(
      { kind: 'field', objectId: r, key: 'a' },
      firstHit(recording, 4),
    )
    expect(written).toMatchObject({ kind: 'write', value: 2 })
  })

  test('falls back to the allocation', () => {
    const event = recording.origin({ kind: 'field', objectId: r, key: 'a' }, firstHit(recording, 2))
    expect(event).toMatchObject({ kind: 'alloc', value: { ref: r } })
    expect(recording.origin({ kind: 'field', objectId: r, key: 'zzz' }, end)?.kind).toBe('alloc')
    expect(recording.origin({ kind: 'field', objectId: 999, key: 'a' }, end)).toBeNull()
  })

  test('field history: allocation, writes and deletes of the key', () => {
    const result = recording.history({ kind: 'field', objectId: r, key: 'a' }, end)
    expect(result.events.map((e) => e.kind)).toEqual(['alloc', 'write', 'delete'])
  })

  test('allocation times', () => {
    const time = recording.allocationTime(r)
    expect(time).not.toBeNull()
    expect(recording.locationAt(time!)?.opName).toBe('Record')
    expect(recording.allocationTime(1)).toBeNull()
    expect(recording.allocationTime(123456)).toBeNull()
    expect(recording.allocationTime(-3)).toBeNull()
  })
})

const LOCALS = `fn f(p) {
  var q = p + 1
  q = q * 2
  q
}
let g = f(5)
var h = 1
h = g`

describe('origin of variables', () => {
  const recording = recordSource(LOCALS)
  const end = recording.length

  test('parameters and locals', () => {
    const at = firstHit(recording, 4)
    const q = recording.origin(localTarget(recording, at, 'q'), at)
    expect(q).toMatchObject({ kind: 'write', value: 12 })
    expect(lineOf(recording, q)).toBe(3)
    const p = recording.origin(localTarget(recording, at, 'p'), at)
    expect(p).toMatchObject({ kind: 'declare', value: 5 })
    expect(lineOf(recording, p)).toBe(6)
    const beforeWrite = recording.origin(localTarget(recording, at, 'q'), firstHit(recording, 3))
    expect(beforeWrite).toMatchObject({ kind: 'declare', value: 6 })
  })

  test('globals', () => {
    expect(recording.origin({ kind: 'global', name: 'h' }, end)).toMatchObject({
      kind: 'write',
      value: 12,
    })
    expect(recording.origin({ kind: 'global', name: 'g' }, end)).toMatchObject({
      kind: 'declare',
      value: 12,
    })
    expect(recording.origin({ kind: 'global', name: 'nope' }, end)).toBeNull()
    expect(
      recording.history({ kind: 'global', name: 'h' }, end).events.map((e) => e.value),
    ).toEqual([1, 12])
  })

  test('origin never returns an event at or after `before`', () => {
    for (let before = 0; before <= end; before++) {
      const event = recording.origin({ kind: 'global', name: 'h' }, before)
      if (event !== null) expect(event.time).toBeLessThan(before)
    }
  })

  test('invalid times throw InternalError', () => {
    expect(() => recording.origin({ kind: 'global', name: 'h' }, end + 1)).toThrow(InternalError)
    expect(() => recording.history({ kind: 'global', name: 'h' }, -1)).toThrow(InternalError)
  })
})

const CELLS = `fn counter() {
  var n = 0
  let inc = || { n = n + 1
    n }
  inc()
  inc
}
let c = counter()
c()
c()`

describe('cells', () => {
  const recording = recordSource(CELLS)
  const end = recording.length
  const insideLastCall = firstHit(recording, 4, 2)
  const cellTarget = recording.stateAt(insideLastCall).frames.at(-1)!.captures[0]!.target

  test('a closed cell is reported as a cell target', () => {
    expect(cellTarget.kind).toBe('cell')
  })

  test('writes before closing are found on the owner slot', () => {
    const event = recording.origin(cellTarget, firstHit(recording, 9))
    expect(event).toMatchObject({ kind: 'write', value: 1, target: { kind: 'local' } })
    expect(lineOf(recording, event)).toBe(3)
  })

  test('writes after closing are cell writes', () => {
    const event = recording.origin(cellTarget, end)
    expect(event).toMatchObject({ kind: 'write', value: 3, target: cellTarget })
  })

  test('history of the cell spans the owner slot and the closed cell', () => {
    const result = recording.history(cellTarget, end)
    expect(result.events.map((e) => [e.kind, e.value])).toEqual([
      ['declare', 0],
      ['write', 1],
      ['write', 2],
      ['write', 3],
    ])
  })

  test('history of the owner slot includes the closed cell', () => {
    const at = firstHit(recording, 5)
    const result = recording.history(localTarget(recording, at, 'n'), at)
    expect(result.events.map((e) => e.value)).toEqual([0, 1, 2, 3])
  })

  test('an open capture is reported as the owner slot', () => {
    const insideFirstCall = firstHit(recording, 4)
    const capture = recording.stateAt(insideFirstCall).frames.at(-1)!.captures[0]!
    expect(capture.target.kind).toBe('local')
    expect(capture.value).toEqual({ kind: 'number', value: 1 })
  })
})

const MANY_CELL_WRITES = `fn make_counter() {
  var n = 0
  || { n += 1; n }
}
let tick = make_counter()
for i in 0..130000 { tick() }
print("done")`

describe('history of a heavily written captured variable', () => {
  test('130,000 cell writes give a truncated history instead of a stack overflow', () => {
    const recording = recordSource(MANY_CELL_WRITES)
    expect(recording.outcome.kind).toBe('finished')
    const target = localTarget(recording, firstHit(recording, 3), 'n')
    const result = recording.history(target, recording.length)
    expect(result.total).toBe(130_001)
    expect(result.truncated).toBe(true)
    expect(result.events.length).toBeLessThanOrEqual(1000)
    expect(result.events[0]).toMatchObject({ kind: 'declare', value: 0 })
    expect(result.events.at(-1)).toMatchObject({ kind: 'write', value: 130_000 })
  })
})

const LOOPS = `fn run() {
  for i in 0..3 {
    let sq = i * i
  }
  for j in 0..2 {
    let k = j
  }
}
run()`

describe('history of bindings', () => {
  const recording = recordSource(LOOPS)

  test('a loop variable spans its iterations', () => {
    const at = firstHit(recording, 3, 1)
    const result = recording.history(localTarget(recording, at, 'i'), at)
    expect(result.events.map((e) => [e.kind, e.value])).toEqual([
      ['declare', 0],
      ['declare', 1],
      ['declare', 2],
    ])
  })

  test('a slot reused by a different binding is excluded', () => {
    const at = firstHit(recording, 6, 1)
    const target = localTarget(recording, at, 'j')
    expect(target).toEqual(localTarget(recording, firstHit(recording, 3), 'i'))
    const result = recording.history(target, at)
    expect(result.events.map((e) => [e.kind, e.value])).toEqual([
      ['declare', 0],
      ['declare', 1],
    ])
  })

  test('before any declaration the history is empty', () => {
    const at = firstHit(recording, 3)
    const target = localTarget(recording, at, 'i')
    expect(recording.history(target, 0)).toEqual({ events: [], total: 0, truncated: false })
  })

  test('windows and sampling keep the first and the last event', () => {
    const many = recordSource('var x = 0\nfor i in 0..100 {\n  x = i\n}')
    const all = many.history({ kind: 'global', name: 'x' }, many.length)
    expect(all.total).toBe(101)
    const sampled = many.history({ kind: 'global', name: 'x' }, many.length, { limit: 5 })
    expect(sampled.truncated).toBe(true)
    expect(sampled.total).toBe(101)
    expect(sampled.events.map((e) => e.value)).toEqual([0, 24, 49, 74, 99])
    const one = many.history({ kind: 'global', name: 'x' }, many.length, { limit: 1 })
    expect(one.events.map((e) => e.value)).toEqual([0])
    expect(many.history({ kind: 'global', name: 'x' }, 0, { limit: 0 }).events).toEqual([])
    const lastTime = all.events.at(-1)!.time
    const windowed = many.history({ kind: 'global', name: 'x' }, 0, {
      from: all.events[10]!.time,
      to: lastTime,
    })
    expect(windowed.events.map((e) => e.value)).toEqual(Array.from({ length: 90 }, (_, k) => k + 9))
  })

  test('object history lists every event on the object', () => {
    const lists = recordSource(LISTS)
    const xs = refId(lists, lists.length, 'xs')
    const kinds = lists
      .history({ kind: 'object', objectId: xs }, lists.length)
      .events.map((e) => e.op ?? e.kind)
    expect(kinds).toEqual(['alloc', 'append', 'insert', 'write', 'remove', 'pop'])
  })
})
