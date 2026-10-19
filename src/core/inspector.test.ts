import { describe, expect, test } from 'vitest'
import type { FrameView, Recording, StateView, ValueView } from './api-types'
import { builtinIndex } from './builtin-names'
import { recordSource } from './testing/recording'

function firstHit(recording: Recording, line: number, occurrence = 0): number {
  const time = recording.lineHits(line)[occurrence]
  if (time === undefined) throw new Error(`line ${line} never ran`)
  return time
}

/** The first time at or after `from` whose instruction is `opName`. */
function nextOp(recording: Recording, from: number, opName: string): number {
  for (let t = from; t < recording.length; t++) {
    if (recording.locationAt(t)?.opName === opName) return t
  }
  throw new Error(`no ${opName} after ${from}`)
}

function plain(value: ValueView): unknown {
  switch (value.kind) {
    case 'nil':
      return null
    case 'ref':
      return `#${value.type}`
    default:
      return value.value
  }
}

function localsOf(frame: FrameView | undefined): Record<string, unknown> {
  return Object.fromEntries((frame?.locals ?? []).map((local) => [local.name, plain(local.value)]))
}

function top(view: StateView): FrameView {
  const frame = view.frames.at(-1)
  if (frame === undefined) throw new Error('no frames')
  return frame
}

function refOf(value: ValueView | undefined): number {
  if (value?.kind !== 'ref') throw new Error('not a reference')
  return value.id
}

const SCOPES = `fn f() {
  let a = 1
  {
    let b = a + 1
    print(b)
  }
  let c = 3
  c
}
fn m(v) {
  match v {
    n if n > 5 => n,
    n => n + 1,
  }
}
f()
m(3)`

describe('frames and locals', () => {
  const recording = recordSource(SCOPES)

  test('a local becomes live just after its Declare', () => {
    const declare = nextOp(recording, firstHit(recording, 4), 'Declare')
    expect(localsOf(top(recording.stateAt(declare)))).toEqual({ a: 1 })
    expect(top(recording.stateAt(declare)).temps.map(plain)).toEqual([2])
    expect(localsOf(top(recording.stateAt(declare + 1)))).toEqual({ a: 1, b: 2 })
    expect(top(recording.stateAt(declare + 1)).temps).toEqual([])
  })

  test('a block local dies after the block-ending PopN and its slot is reused', () => {
    const popN = nextOp(recording, firstHit(recording, 5), 'PopN')
    expect(localsOf(top(recording.stateAt(popN)))).toEqual({ a: 1, b: 2 })
    expect(localsOf(top(recording.stateAt(popN + 1)))).toEqual({ a: 1 })
    const declareC = nextOp(recording, popN, 'Declare')
    const view = top(recording.stateAt(declareC + 1))
    expect(localsOf(view)).toEqual({ a: 1, c: 3 })
    expect(view.locals.map((local) => local.slot)).toEqual([1, 2])
    expect(view.locals[1]).toMatchObject({ kind: 'let', mutable: false, slot: 2 })
  })

  test('guarded arms: bindings stay live through the guard-failure PopN', () => {
    const guardFail = nextOp(recording, firstHit(recording, 12), 'PopN')
    const failing = top(recording.stateAt(guardFail))
    expect(localsOf(failing)).toEqual({ v: 3, n: 3 })
    expect(failing.temps).toEqual([])
    expect(localsOf(top(recording.stateAt(guardFail + 1)))).toEqual({ v: 3 })
    const secondArm = firstHit(recording, 13, 1)
    expect(localsOf(top(recording.stateAt(secondArm)))).toEqual({ v: 3, n: 3 })
  })

  test('hidden locals are not listed and not counted as temps', () => {
    const matchPattern = firstHit(recording, 12)
    const frame = top(recording.stateAt(matchPattern))
    expect(frame.locals.map((local) => local.name)).toEqual(['v'])
    expect(frame.temps).toEqual([])
    expect(frame.locals[0]).toMatchObject({ kind: 'param', target: { kind: 'local', slot: 1 } })
  })

  test('the top frame shows its instruction; callers show the call they wait on', () => {
    const insidePrint = nextOp(recording, firstHit(recording, 5), 'Call')
    const view = recording.stateAt(insidePrint)
    expect(view.frames.map((frame) => frame.name)).toEqual(['<top level>', 'f'])
    const caller = view.frames[0]!
    const callStart = SCOPES.indexOf('f()\n')
    expect(caller.span).toEqual({ start: callStart, end: callStart + 3 })
    expect(caller.stmtSpan.start).toBe(callStart)
    expect(caller.line).toBe(16)
    expect(caller.library).toBe(false)
    expect(caller.source).toBe('main')
    const callee = view.frames[1]!
    expect(callee.line).toBe(5)
    expect(callee.span).toEqual(view.location!.span)
    expect(callee.temps.map(plain)).toEqual(['#builtin', 2])
  })

  test('shadowed names are both listed, in slot order', () => {
    const shadow = recordSource(
      'fn g() {\n  let x = 1\n  {\n    let x = 2\n    print(x)\n  }\n}\ng()',
    )
    const view = top(shadow.stateAt(firstHit(shadow, 5)))
    expect(view.locals.map((local) => [local.name, plain(local.value), local.slot])).toEqual([
      ['x', 1, 1],
      ['x', 2, 2],
    ])
  })
})

const CAPTURES = `fn counter() {
  var n = 0
  let inc = || { n = n + 1
    n }
  inc()
  inc
}
let c = counter()
c()`

describe('captures', () => {
  const recording = recordSource(CAPTURES)

  test('an open capture aliases the owner frame slot', () => {
    const view = recording.stateAt(firstHit(recording, 4))
    const [owner, lambda] = view.frames.slice(-2)
    expect(lambda!.captures).toEqual([
      {
        name: 'n',
        value: { kind: 'number', value: 1 },
        target: { kind: 'local', frameUid: owner!.uid, slot: 1 },
      },
    ])
  })

  test('a closed capture is a cell, also in the function object view', () => {
    const view = recording.stateAt(firstHit(recording, 4, 1))
    const capture = top(view).captures[0]!
    expect(capture.target.kind).toBe('cell')
    expect(capture.value).toEqual({ kind: 'number', value: 2 })
    const fn = view.heap.get(refOf(view.globals.find((g) => g.name === 'c')?.value))
    expect(fn).toMatchObject({ type: 'function', name: 'inc', library: false, captures: [capture] })
  })
})

describe('globals and values', () => {
  const source = `let n = nil
var flag = true
let s = "hi"
let rg = 0..3
let pr = print
fn h() { 1 }
let long = [${Array.from({ length: 40 }, (_, k) => k).join(', ')}]
for i in [1] {
  print(i)
}`
  const recording = recordSource(source)

  test('globals in definition order with kind, mutability and values', () => {
    const view = recording.stateAt(recording.length)
    expect(view.globals.map((g) => [g.name, g.kind, g.mutable])).toEqual([
      ['n', 'let', false],
      ['flag', 'var', true],
      ['s', 'let', false],
      ['rg', 'let', false],
      ['pr', 'let', false],
      ['h', 'fn', false],
      ['long', 'let', false],
    ])
    expect(view.globals.slice(0, 3).map((g) => g.value)).toEqual([
      { kind: 'nil' },
      { kind: 'bool', value: true },
      { kind: 'string', value: 'hi' },
    ])
    expect(view.globals[1]!.target).toEqual({ kind: 'global', name: 'flag' })
    expect(view.globals[1]!.declSpan.start).toBe(source.indexOf('flag'))
  })

  test('references carry their type and a bounded preview', () => {
    const globals = recording.stateAt(recording.length).globals
    const value = (name: string): ValueView => globals.find((g) => g.name === name)!.value
    expect(value('rg')).toMatchObject({ kind: 'ref', type: 'range', preview: '0..3' })
    expect(value('pr')).toMatchObject({ kind: 'ref', type: 'builtin', preview: '<builtin print>' })
    expect(value('h')).toMatchObject({ kind: 'ref', type: 'function', preview: '<fn h>' })
    const long = value('long')
    expect(long.kind === 'ref' && long.preview.length).toBe(48)
    expect(long.kind === 'ref' && long.preview.endsWith('…')).toBe(true)
  })

  test('builtins, ranges and iterators as objects', () => {
    const view = recording.stateAt(firstHit(recording, 9))
    const heap = [...view.heap.values()]
    expect(heap.find((o) => o.type === 'builtin')).toEqual({
      type: 'builtin',
      id: -(builtinIndex('print') + 1),
      name: 'print',
    })
    expect(heap.find((o) => o.type === 'range')).toMatchObject({
      start: 0,
      end: 3,
      step: 1,
      inclusive: false,
    })
    expect(heap.find((o) => o.type === 'iterator')).toMatchObject({
      position: 1,
      source: { kind: 'ref', type: 'list' },
    })
  })
})

const HEAP = `let a = [1, [2, 3]]
let r = {k: a, f: fn(x) { x }}
fn h(p) {
  let q = {z: p}
  print(q)
}
h(a)`

describe('heap', () => {
  const recording = recordSource(HEAP)
  const at = nextOp(recording, firstHit(recording, 5), 'Call')
  const view = recording.stateAt(at)
  const global = (name: string): number => refOf(view.globals.find((g) => g.name === name)?.value)

  test('breadth first from globals, then frame regions, then children', () => {
    const a = global('a')
    const r = global('r')
    const q = refOf(top(view).locals.find((local) => local.name === 'q')?.value)
    const listA = view.heap.get(a)
    const inner = listA?.type === 'list' ? refOf(listA.items[1]) : -1
    const record = view.heap.get(r)
    const lambda = record?.type === 'record' ? refOf(record.entries[1]?.value) : -1
    expect([...view.heap.keys()]).toEqual([
      a,
      r,
      global('h'),
      1,
      q,
      -(builtinIndex('print') + 1),
      inner,
      lambda,
    ])
    expect(view.heapTruncated).toBe(false)
    expect(view.heap.get(1)).toMatchObject({ type: 'function', name: '<top level>' })
    expect(view.heap.get(lambda)).toMatchObject({ type: 'function', name: null, captures: [] })
  })

  test('heapLimit bounds the walk and reports truncation', () => {
    const limited = recordSource(HEAP, { heapLimit: 3 })
    const small = limited.stateAt(at)
    expect([...small.heap.keys()]).toEqual([global('a'), global('r'), global('h')])
    expect(small.heapTruncated).toBe(true)
    const exact = recordSource(HEAP, { heapLimit: 8 }).stateAt(at)
    expect(exact.heap.size).toBe(8)
    expect(exact.heapTruncated).toBe(false)
  })

  test('objectAt returns reachable objects and null otherwise', () => {
    expect(recording.objectAt(at, global('a'))).toEqual(view.heap.get(global('a')))
    expect(recording.objectAt(0, global('a'))).toBeNull()
    expect(recording.objectAt(at, 987654)).toBeNull()
  })
})

describe('paging', () => {
  const recording = recordSource(`let big = list(0..250)
var rec = {}
for i in 0..150 {
  rec["k" + str(i)] = i
}`)
  const end = recording.length
  const view = recording.stateAt(end)
  const big = refOf(view.globals[0]?.value)
  const rec = refOf(view.globals[1]?.value)

  test('views carry the first 100 items and the total length', () => {
    const list = view.heap.get(big)
    expect(list?.type === 'list' && [list.offset, list.items.length, list.length]).toEqual([
      0, 100, 250,
    ])
    const record = view.heap.get(rec)
    expect(
      record?.type === 'record' && [record.offset, record.entries.length, record.length],
    ).toEqual([0, 100, 150])
  })

  test('objectAt pages through lists and records', () => {
    const page = recording.objectAt(end, big, { offset: 200, limit: 100 })
    expect(
      page?.type === 'list' && [page.offset, page.items.length, plain(page.items[0]!)],
    ).toEqual([200, 50, 200])
    const entries = recording.objectAt(end, rec, { offset: 140, limit: 5 })
    expect(entries?.type === 'record' && entries.entries.map((e) => e.key)).toEqual([
      'k140',
      'k141',
      'k142',
      'k143',
      'k144',
    ])
    const beyond = recording.objectAt(end, big, { offset: 999, limit: 10 })
    expect(beyond?.type === 'list' && [beyond.offset, beyond.items.length]).toEqual([250, 0])
    const odd = recording.objectAt(end, big, { offset: -5, limit: Number.NaN })
    expect(odd?.type === 'list' && [odd.offset, odd.items.length]).toEqual([0, 0])
  })
})

describe('time N', () => {
  test('finished: no frames, no location, globals kept', () => {
    const recording = recordSource('let x = 1\nprint(x)')
    const view = recording.stateAt(recording.length)
    expect(view.location).toBeNull()
    expect(view.frames).toEqual([])
    expect(view.globals.map((g) => g.name)).toEqual(['x'])
    expect(view.outputCount).toBe(1)
    expect(view.error).toBeNull()
    expect(recording.stateAt(recording.length - 1).outputCount).toBe(1)
  })

  test('error: the paused state before the failing step, with the error', () => {
    const recording = recordSource('fn f(x) {\n  x.q\n}\nprint(1)\nf(5)')
    expect(recording.outcome.kind).toBe('error')
    const view = recording.stateAt(recording.length)
    expect(view.error).toEqual(recording.outcome.kind === 'error' ? recording.outcome.error : null)
    expect(view.location?.opName).toBe('GetField')
    expect(view.frames.map((frame) => frame.name)).toEqual(['<top level>', 'f'])
    expect(top(view).temps.map(plain)).toEqual([5])
    expect(view.outputCount).toBe(1)
    expect(recording.stateAt(recording.length - 1).error).toBeNull()
  })

  test('step limit: the paused state without an error', () => {
    const recording = recordSource('fn f(x) {\n  x + 1\n}\nf(5)', { maxSteps: 5 })
    expect(recording.outcome).toEqual({ kind: 'step-limit', maxSteps: 5 })
    const view = recording.stateAt(5)
    expect(view.error).toBeNull()
    expect(view.location).toEqual(recording.locationAt(5))
    expect(view.frames.length).toBe(recording.depthAt(5) + 1)
  })
})
