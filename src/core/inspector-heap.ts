/**
 * Value and object views, and the heap walk (ARCHITECTURE §7.4): breadth first from the roots
 * (globals in definition order, then each frame's stack region in slot order followed by its
 * closure's captures), children in `ObjectView` order, each id once, builtins never expanded.
 * Iterative throughout, so nesting depth is unlimited.
 */
import type { CaptureView, ObjectView, RefType, ValueView, WriteTarget } from './api-types'
import { InternalError } from './diagnostics'
import type { CellObj, ClosureObj, HeapObject, Value, VM } from './runtime-types'
import { preview } from './values'

export const PREVIEW_LENGTH = 48
export const DEFAULT_PAGE_LIMIT = 100

/** Natives and library closures (negative ids) are builtins: shown by name, never expanded. */
function isBuiltin(object: HeapObject): boolean {
  return object.type === 'native' || (object.type === 'closure' && object.id < 0)
}

export function refType(object: HeapObject): RefType {
  switch (object.type) {
    case 'list':
    case 'record':
    case 'range':
    case 'iterator':
      return object.type
    case 'native':
      return 'builtin'
    case 'closure':
      return object.id < 0 ? 'builtin' : 'function'
    default:
      throw new InternalError(`a ${object.type} is not a value`)
  }
}

export function valueView(value: Value): ValueView {
  if (value === null) return { kind: 'nil' }
  switch (typeof value) {
    case 'boolean':
      return { kind: 'bool', value }
    case 'number':
      return { kind: 'number', value }
    case 'string':
      return { kind: 'string', value }
    default:
      return {
        kind: 'ref',
        id: value.id,
        type: refType(value),
        preview: preview(value, PREVIEW_LENGTH),
      }
  }
}

/** The current value of a cell: open cells alias their stack slot. */
export function cellValue(vm: VM, cell: CellObj): Value {
  return cell.open ? (vm.stack[cell.stackIndex] as Value) : cell.value
}

/** An open cell is reported as its owner's local slot, a closed one as the cell (§6.7). */
export function cellTarget(cell: CellObj): WriteTarget {
  return cell.open
    ? { kind: 'local', frameUid: cell.ownerFrameUid, slot: cell.slot }
    : { kind: 'cell', cellId: cell.id }
}

export function captureViews(vm: VM, closure: ClosureObj): CaptureView[] {
  const names = closure.proto.debug.upvalueNames
  return closure.upvalues.map((cell, index) => ({
    name: names[index] ?? `#${index}`,
    value: valueView(cellValue(vm, cell)),
    target: cellTarget(cell),
  }))
}

export interface PageRange {
  readonly offset: number
  readonly limit: number
}

const FIRST_PAGE: PageRange = { offset: 0, limit: DEFAULT_PAGE_LIMIT }

export function objectView(vm: VM, object: HeapObject, page: PageRange = FIRST_PAGE): ObjectView {
  if (isBuiltin(object)) {
    const name = object.type === 'native' ? object.name : (object as ClosureObj).proto.name
    return { type: 'builtin', id: object.id, name: name ?? '' }
  }
  switch (object.type) {
    case 'list': {
      const { offset, end } = pageBounds(page, object.items.length)
      const items = object.items.slice(offset, end).map(valueView)
      return { type: 'list', id: object.id, offset, items, length: object.items.length }
    }
    case 'record':
      return recordView(object.id, object.fields, page)
    case 'closure': {
      const proto = object.proto
      return {
        type: 'function',
        id: object.id,
        name: proto.name,
        protoId: proto.id,
        library: proto.debug.library,
        captures: captureViews(vm, object),
      }
    }
    case 'range':
      return {
        type: 'range',
        id: object.id,
        start: object.start,
        end: object.end,
        step: object.step,
        inclusive: object.inclusive,
      }
    case 'iterator':
      return {
        type: 'iterator',
        id: object.id,
        source: valueView(object.source),
        position: object.position,
      }
    default:
      throw new InternalError(`a ${object.type} is not a value`)
  }
}

function pageBounds(page: PageRange, length: number): { offset: number; end: number } {
  const offset = Math.min(Math.max(0, Math.floor(page.offset) || 0), length)
  const limit = Math.max(0, Math.floor(page.limit) || 0)
  return { offset, end: Math.min(length, offset + limit) }
}

function recordView(id: number, fields: ReadonlyMap<string, Value>, page: PageRange): ObjectView {
  const { offset, end } = pageBounds(page, fields.size)
  const entries: { key: string; value: ValueView }[] = []
  let index = 0
  for (const [key, value] of fields) {
    if (index >= end) break
    if (index >= offset) entries.push({ key, value: valueView(value) })
    index++
  }
  return { type: 'record', id, offset, entries, length: fields.size }
}

// ---------------------------------------------------------------------------------------------
// The walk

/** Calls `visit` for every root value in root order. */
function forEachRoot(vm: VM, visit: (value: Value) => void): void {
  for (const value of vm.globals.values()) visit(value)
  const frames = vm.frames
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!
    const regionEnd = i + 1 < frames.length ? frames[i + 1]!.base : vm.stack.length
    for (let index = frame.base; index < regionEnd; index++) visit(vm.stack[index] as Value)
    for (const cell of frame.closure.upvalues) visit(cellValue(vm, cell))
  }
}

/** Calls `visit` for every child of `object` in `ObjectView` order. */
function forEachChild(vm: VM, object: HeapObject, visit: (value: Value) => void): void {
  if (isBuiltin(object)) return
  switch (object.type) {
    case 'list':
      for (const item of object.items) visit(item)
      break
    case 'record':
      for (const value of object.fields.values()) visit(value)
      break
    case 'closure':
      for (const cell of object.upvalues) visit(cellValue(vm, cell))
      break
    case 'iterator':
      visit(object.source)
      break
    default:
      break
  }
}

/**
 * Breadth-first traversal; `onObject` receives each reachable object once, in visiting order, and
 * returns false to stop. `limit` bounds the number of objects discovered.
 */
function walk(vm: VM, limit: number, onObject: (object: HeapObject) => boolean): boolean {
  const seen = new Set<number>()
  const queue: HeapObject[] = []
  let truncated = false
  const discover = (value: Value): void => {
    if (typeof value !== 'object' || value === null || seen.has(value.id)) return
    if (queue.length >= limit) {
      truncated = true
      return
    }
    seen.add(value.id)
    queue.push(value)
  }
  forEachRoot(vm, discover)
  for (let head = 0; head < queue.length; head++) {
    const object = queue[head]!
    if (!onObject(object)) return truncated
    if (!truncated) forEachChild(vm, object, discover)
  }
  return truncated
}

export interface HeapWalk {
  readonly heap: ReadonlyMap<number, ObjectView>
  readonly truncated: boolean
}

export function walkHeap(vm: VM, heapLimit: number): HeapWalk {
  const heap = new Map<number, ObjectView>()
  const truncated = walk(vm, Math.max(0, heapLimit), (object) => {
    heap.set(object.id, objectView(vm, object))
    return true
  })
  return { heap, truncated }
}

/** The object with `id` if it is reachable from the roots, else null. */
export function findReachable(vm: VM, id: number): HeapObject | null {
  let found: HeapObject | null = null
  walk(vm, Infinity, (object) => {
    if (object.id === id) found = object
    return found === null
  })
  return found
}
