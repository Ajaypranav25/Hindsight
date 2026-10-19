import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import type { ObjectView, StateView, ValueView } from '../../core/api-types'
import { compile, record } from '../../core/index'
import {
  BOX_GAP,
  collectRoots,
  FIT_MIN_ZOOM,
  fitZoom,
  layoutHeap,
  MAX_BOXES,
  type HeapLayout,
  type HeapRoot,
  type LayoutMemory,
} from './heap-layout'

const num = (value: number): ValueView => ({ kind: 'number', value })
const ref = (id: number, type: 'list' | 'record' | 'function' = 'list'): ValueView => ({
  kind: 'ref',
  id,
  type,
  preview: `#${id}`,
})
const list = (id: number, items: ValueView[], length = items.length): ObjectView => ({
  type: 'list',
  id,
  offset: 0,
  items,
  length,
})
const recordOf = (
  id: number,
  entries: [string, ValueView][],
  length = entries.length,
): ObjectView => ({
  type: 'record',
  id,
  offset: 0,
  entries: entries.map(([key, value]) => ({ key, value })),
  length,
})
const root = (name: string, value: ValueView): HeapRoot => ({
  key: `local:${name}`,
  name,
  group: 'local',
  value,
})
const heapOf = (...objects: ObjectView[]) => new Map(objects.map((o) => [o.id, o]))

function assertNoColumnOverlap(layout: HeapLayout): void {
  const byColumn = new Map<number, HeapLayout['boxes'][number][]>()
  for (const box of layout.boxes)
    byColumn.set(box.column, [...(byColumn.get(box.column) ?? []), box])
  for (const boxes of byColumn.values()) {
    const sorted = [...boxes].sort((a, b) => a.y - b.y)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1]!.y + sorted[i - 1]!.height + BOX_GAP).toBeLessThanOrEqual(sorted[i]!.y)
    }
  }
}

/** A linked chain of `n` records: r1 -> r2 -> ... */
function chain(n: number, start = 1): ObjectView[] {
  return Array.from({ length: n }, (_, i) =>
    recordOf(start + i, [
      ['value', num(i)],
      ['next', i + 1 < n ? ref(start + i + 1, 'record') : { kind: 'nil' }],
    ]),
  )
}

describe('layoutHeap', () => {
  test('lays out roots, then objects in columns by distance, deterministically', () => {
    const input = {
      roots: [root('xs', ref(1)), root('n', num(3)), root('r', ref(2, 'record'))],
      heap: heapOf(list(1, [ref(3), num(5)]), recordOf(2, [['a', ref(3)]]), list(3, [num(1)])),
    }
    const a = layoutHeap(input)
    const b = layoutHeap(input)
    expect(a).toEqual(b)
    expect(a.roots.map((chip) => chip.text)).toEqual(['list', '3', 'record'])
    expect(a.roots[1]!.port).toBeNull()
    const columns = Object.fromEntries(a.boxes.map((box) => [box.id, box.column]))
    expect(columns).toEqual({ 1: 1, 2: 1, 3: 2 })
    // first reference order within a column
    const first = a.boxes.filter((box) => box.column === 1).map((box) => box.id)
    expect(first).toEqual([1, 2])
    expect(a.boxes.find((box) => box.id === 1)!.x).toBeGreaterThan(a.roots[0]!.width)
    expect(a.edges.map((edge) => edge.key)).toEqual([
      'r:local:xs',
      'r:local:r',
      'b:1:0:0',
      'b:2:0:a',
    ])
    expect(a.edges.every((edge) => edge.route === 'forward' && edge.path.startsWith('M'))).toBe(
      true,
    )
    assertNoColumnOverlap(a)
  })

  test('lists of short primitives become horizontal strips; others are vertical rows', () => {
    const layout = layoutHeap({
      roots: [root('a', ref(1)), root('b', ref(2))],
      heap: heapOf(list(1, [num(1), num(2), num(3)]), list(2, [num(1), ref(1)])),
    })
    const strip = layout.boxes.find((box) => box.id === 1)!
    expect(strip.horizontal).toBe(true)
    expect(strip.rows.map((r) => r.text)).toEqual(['1', '2', '3'])
    expect(new Set(strip.rows.map((r) => r.y)).size).toBe(1)
    expect(layout.boxes.find((box) => box.id === 2)!.horizontal).toBe(false)
  })

  test('caps list cells, record rows and boxes, reporting what is hidden', () => {
    const longList = list(
      1,
      Array.from({ length: 100 }, (_, i) => num(i)),
      500,
    )
    const bigRecord = recordOf(
      2,
      Array.from({ length: 30 }, (_, i): [string, ValueView] => [`k${i}`, num(i)]),
    )
    const layout = layoutHeap({
      roots: [root('l', ref(1)), root('r', ref(2, 'record'))],
      heap: heapOf(longList, bigRecord),
    })
    const l = layout.boxes.find((box) => box.id === 1)!
    expect(l.rows).toHaveLength(13)
    expect(l.rows[12]!).toMatchObject({ more: true, text: '+488 more' })
    expect(l.title).toBe('list [500]')
    const r = layout.boxes.find((box) => box.id === 2)!
    expect(r.rows).toHaveLength(11)
    expect(r.rows[10]!.text).toBe('+20 more')

    const many = chain(80)
    const capped = layoutHeap({ roots: [root('head', ref(1, 'record'))], heap: heapOf(...many) })
    expect(capped.boxes).toHaveLength(MAX_BOXES)
    expect(capped.hiddenCount).toBe(20)
    const last = capped.boxes.find((box) => box.id === MAX_BOXES)!
    expect(last.rows.find((r) => r.label === 'next')!.target).toBeNull()
    expect(capped.edges).toHaveLength(MAX_BOXES)
  })

  test('routes self references and back edges around boxes', () => {
    const layout = layoutHeap({
      roots: [root('a', ref(1, 'record'))],
      heap: heapOf(
        recordOf(1, [
          ['self', ref(1, 'record')],
          ['b', ref(2, 'record')],
        ]),
        recordOf(2, [['back', ref(1, 'record')]]),
      ),
    })
    const routes = Object.fromEntries(layout.edges.map((edge) => [edge.key, edge.route]))
    expect(routes).toEqual({
      'r:local:a': 'forward',
      'b:1:0:self': 'self',
      'b:1:1:b': 'forward',
      'b:2:0:back': 'back',
    })
    expect(layout.bounds.y).toBeLessThan(0)
  })

  test('describes functions, ranges, builtins and iterators', () => {
    const layout = layoutHeap({
      roots: [
        root('f', ref(1, 'function')),
        root('r', ref(2)),
        root('p', ref(3)),
        root('it', ref(4)),
      ],
      heap: heapOf(
        {
          type: 'function',
          id: 1,
          name: null,
          protoId: 2,
          library: false,
          captures: [{ name: 'count', value: num(4), target: { kind: 'cell', cellId: 1 } }],
        },
        { type: 'range', id: 2, start: 0, end: 10, step: 1, inclusive: true },
        { type: 'builtin', id: 3, name: 'print' },
        { type: 'iterator', id: 4, source: ref(2), position: 3 },
      ),
    })
    const text = (id: number) => layout.boxes.find((box) => box.id === id)!.rows.map((r) => r.text)
    expect(text(1)).toEqual(['lambda', '4'])
    expect(text(2)).toEqual(['0..=10'])
    expect(text(3)).toEqual(['print'])
    expect(text(4)[0]).toBe('at 3')
    expect(layout.edges.some((edge) => edge.key === 'b:4:1:source' && edge.route === 'back')).toBe(
      true,
    )
  })

  test('keeps persisting boxes in place when the heap changes', () => {
    const before = layoutHeap({
      roots: [root('a', ref(1)), root('b', ref(2)), root('c', ref(3))],
      heap: heapOf(list(1, [num(1)]), list(2, [num(2)]), list(3, [num(3)])),
    })
    // `a` disappears, a new object appears first in reference order
    const after = layoutHeap(
      {
        roots: [root('z', ref(9)), root('b', ref(2)), root('c', ref(3))],
        heap: heapOf(list(9, [num(9), num(9)]), list(2, [num(2)]), list(3, [num(3)])),
      },
      before.memory,
    )
    const pos = (layout: HeapLayout, id: number) => {
      const box = layout.boxes.find((b) => b.id === id)!
      return { x: box.x, y: box.y, column: box.column }
    }
    expect(pos(after, 2)).toEqual(pos(before, 2))
    expect(pos(after, 3)).toEqual(pos(before, 3))
    // the new box takes the freed slot at the top
    expect(pos(after, 9).y).toBe(pos(before, 1).y)
    assertNoColumnOverlap(after)
    // a returning box gets its old place back
    const back = layoutHeap(
      {
        roots: [root('a', ref(1)), root('c', ref(3))],
        heap: heapOf(list(1, [num(1)]), list(3, [num(3)])),
      },
      after.memory,
    )
    expect(pos(back, 1)).toEqual(pos(before, 1))
  })

  test('stays stable and overlap-free across the steps of a real recording', () => {
    const source = readFileSync('examples/15-linked-list.sight', 'utf8')
    const compiled = compile(source)
    if (!compiled.ok) throw new Error('example does not compile')
    const recording = record(compiled.program, { maxSteps: 50_000 })
    let memory: LayoutMemory | null = null
    let previous: HeapLayout | null = null
    let persisted = 0
    const stride = Math.max(1, Math.floor(recording.length / 150))
    for (let t = 0; t <= recording.length; t += stride) {
      const view: StateView = recording.stateAt(t)
      const frame = view.frames.at(-1) ?? null
      const layout = layoutHeap(
        { roots: collectRoots(frame, view.globals), heap: view.heap },
        memory,
      )
      assertNoColumnOverlap(layout)
      for (const box of layout.boxes) {
        const old = previous?.boxes.find((b) => b.id === box.id)
        if (!old) continue
        persisted++
        expect(box.column).toBe(old.column)
        expect(box.y).toBeGreaterThanOrEqual(old.y)
      }
      memory = layout.memory
      previous = layout
    }
    expect(persisted).toBeGreaterThan(0)
  })
})

describe('collectRoots', () => {
  test('takes locals, captures, then globals without function declarations', () => {
    const span = { start: 0, end: 1 }
    const roots = collectRoots(
      {
        uid: 1,
        name: 'f',
        protoId: 1,
        ip: 0,
        library: false,
        source: 'main',
        span,
        stmtSpan: span,
        line: 1,
        locals: [
          {
            name: 'x',
            slot: 0,
            kind: 'let',
            mutable: false,
            value: num(1),
            declSpan: span,
            target: { kind: 'local', frameUid: 1, slot: 0 },
          },
        ],
        captures: [{ name: 'c', value: num(2), target: { kind: 'cell', cellId: 1 } }],
        temps: [],
      },
      [
        {
          name: 'main',
          kind: 'fn',
          mutable: false,
          value: ref(5, 'function'),
          declSpan: span,
          target: { kind: 'global', name: 'main' },
        },
        {
          name: 'g',
          kind: 'var',
          mutable: true,
          value: num(3),
          declSpan: span,
          target: { kind: 'global', name: 'g' },
        },
      ],
    )
    expect(roots.map((r) => `${r.group}:${r.name}`)).toEqual(['local:x', 'capture:c', 'global:g'])
    expect(collectRoots(null, [])).toEqual([])
  })
})

describe('fitZoom', () => {
  test('never enlarges, and never shrinks below the readable minimum', () => {
    expect(fitZoom({ width: 800, height: 600 }, { width: 200, height: 100 })).toBe(1)
    expect(fitZoom({ width: 450, height: 600 }, { width: 500, height: 100 })).toBeCloseTo(0.9)
    expect(fitZoom({ width: 100, height: 60 }, { width: 2000, height: 900 })).toBe(FIT_MIN_ZOOM)
    expect(fitZoom({ width: 100, height: 60 }, { width: 0, height: 0 })).toBe(1)
  })
})
