/**
 * Differential heaps (ARCHITECTURE §7.13): what points where in one state but not in another.
 * During a what-if, the real run and the fork are compared at the same step, so a pointer the
 * edit removed and one it created (a tree rotation gone wrong, a list that became a cycle) show
 * as two edge sets instead of two pictures to compare by eye.
 */
import type { ObjectView, StateView, ValueView } from './api-types'

export interface HeapEdge {
  /** The holder: `#12` for an object, `global xs` or `local average.xs` for a variable. */
  readonly from: string
  /** The field key, `[index]` or captured name; empty for a variable. */
  readonly label: string
  /** The id of the object pointed at. */
  readonly to: number
}

export interface HeapDiff {
  /** Edges only in `b` (the what-if): pointers the change created. */
  readonly added: readonly HeapEdge[]
  /** Edges only in `a` (the real run): pointers the change removed. */
  readonly removed: readonly HeapEdge[]
  /** Objects reachable only in `b`, and only in `a`. */
  readonly onlyB: readonly number[]
  readonly onlyA: readonly number[]
}

export function edgeKey(edge: HeapEdge): string {
  return `${edge.from}\u0000${edge.label}\u0000${edge.to}`
}

/** Every reference in `state`: from variables into the heap and between heap objects. */
export function heapEdges(state: StateView): HeapEdge[] {
  const edges: HeapEdge[] = []
  const add = (from: string, label: string, value: ValueView): void => {
    if (value.kind === 'ref' && value.type !== 'builtin') edges.push({ from, label, to: value.id })
  }
  for (const global of state.globals) add(`global ${global.name}`, '', global.value)
  state.frames.forEach((frame, depth) => {
    for (const local of frame.locals)
      add(`local ${depth}:${frame.name}.${local.name}`, '', local.value)
  })
  for (const object of state.heap.values()) {
    for (const [label, value] of partsOf(object)) add(`#${object.id}`, label, value)
  }
  return edges
}

function partsOf(object: ObjectView): (readonly [string, ValueView])[] {
  switch (object.type) {
    case 'list':
      return object.items.map((item, i) => [`[${object.offset + i}]`, item] as const)
    case 'record':
      return object.entries.map((entry) => [entry.key, entry.value] as const)
    case 'function':
      return object.captures.map((capture) => [capture.name, capture.value] as const)
    case 'iterator':
      return [['source', object.source]]
    default:
      return []
  }
}

/** The references that differ between `a` (the real run) and `b` (the what-if). */
export function diffHeaps(a: StateView, b: StateView): HeapDiff {
  const edgesA = heapEdges(a)
  const edgesB = heapEdges(b)
  const keysA = new Set(edgesA.map(edgeKey))
  const keysB = new Set(edgesB.map(edgeKey))
  return {
    added: edgesB.filter((edge) => !keysA.has(edgeKey(edge))),
    removed: edgesA.filter((edge) => !keysB.has(edgeKey(edge))),
    onlyB: [...b.heap.keys()].filter((id) => !a.heap.has(id)),
    onlyA: [...a.heap.keys()].filter((id) => !b.heap.has(id)),
  }
}
