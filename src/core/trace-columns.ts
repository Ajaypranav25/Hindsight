/**
 * Columnar storage for recordings (ARCHITECTURE §7.1.6): the per-step trace and the event log live
 * in typed arrays that grow by doubling, never in one object per step.
 *
 * A store may be shared by a recording and its extensions (§7.1.8). Every recording only reads the
 * prefix it owns; extensions write beyond it. Replays are deterministic, so two extensions that
 * write the same position write identical data.
 */
import type { TracedValue, WriteTarget } from './api-types'
import type { HeapObject, Value } from './runtime-types'

const INITIAL_CAPACITY = 1024

function grownSize(current: number, needed: number): number {
  let size = Math.max(current, INITIAL_CAPACITY)
  while (size < needed) size *= 2
  return size
}

function grow<T extends Int32Array | Uint8Array | Float64Array>(array: T, needed: number): T {
  const next = new (array.constructor as new (length: number) => T)(grownSize(array.length, needed))
  next.set(array)
  return next
}

// ---------------------------------------------------------------------------------------------
// The per-step trace

/** Location of the instruction about to execute at each step: proto id, ip and depth. */
export class StepColumns {
  protoIds = new Int32Array(INITIAL_CAPACITY)
  ips = new Int32Array(INITIAL_CAPACITY)
  depths = new Int32Array(INITIAL_CAPACITY)

  set(t: number, protoId: number, ip: number, depth: number): void {
    if (t >= this.protoIds.length) this.ensure(t + 1)
    this.protoIds[t] = protoId
    this.ips[t] = ip
    this.depths[t] = depth
  }

  private ensure(needed: number): void {
    this.protoIds = grow(this.protoIds, needed)
    this.ips = grow(this.ips, needed)
    this.depths = grow(this.depths, needed)
  }
}

// ---------------------------------------------------------------------------------------------
// Strings

/** Interned strings for event values, global names and field keys. Append-only. */
export class StringTable {
  private readonly ids = new Map<string, number>()
  private readonly texts: string[] = []

  intern(text: string): number {
    let id = this.ids.get(text)
    if (id === undefined) {
      id = this.texts.length
      this.texts.push(text)
      this.ids.set(text, id)
    }
    return id
  }

  /** The id of `text`, or -1 when it was never interned. */
  find(text: string): number {
    return this.ids.get(text) ?? -1
  }

  text(id: number): string {
    return this.texts[id]!
  }
}

// ---------------------------------------------------------------------------------------------
// Events

export const EventCode = {
  declare: 0,
  write: 1,
  alloc: 2,
  list: 3,
  delete: 4,
  /** Internal: an open cell was closed (target cell, `b` = slot, `aux` = owner frame uid). */
  cellClosed: 5,
} as const

export const TargetCode = {
  local: 0,
  global: 1,
  field: 2,
  element: 3,
  object: 4,
  cell: 5,
} as const

export const ListOpCode = { append: 0, extend: 1, insert: 2, remove: 3, pop: 4 } as const
export const LIST_OPS = ['append', 'extend', 'insert', 'remove', 'pop'] as const

const ValueTag = { nil: 0, false: 1, true: 2, number: 3, string: 4, ref: 5 } as const

/** Object type codes stored with `alloc` events (in `op`). */
export const AllocType = { other: 0, cell: 1 } as const

/**
 * One row per event. Target fields by target kind: local (`a` frame uid, `b` slot), global
 * (`b` name id), field (`a` object id, `b` key id), element (`a` object id, `b` index), object
 * (`a` object id), cell (`a` cell id). List events keep the index in `b` and the count in `aux`;
 * cell allocations keep the owner slot in `b` and the owner frame uid in `aux`.
 */
export class EventColumns {
  readonly strings = new StringTable()
  times = new Int32Array(INITIAL_CAPACITY)
  kinds = new Uint8Array(INITIAL_CAPACITY)
  targetKinds = new Uint8Array(INITIAL_CAPACITY)
  a = new Int32Array(INITIAL_CAPACITY)
  b = new Int32Array(INITIAL_CAPACITY)
  aux = new Int32Array(INITIAL_CAPACITY)
  ops = new Uint8Array(INITIAL_CAPACITY)
  valueTags = new Uint8Array(INITIAL_CAPACITY)
  valueNums = new Float64Array(INITIAL_CAPACITY)

  /** Writes row `at`; `value` is encoded as a traced value. */
  set(
    at: number,
    time: number,
    kind: number,
    targetKind: number,
    a: number,
    b: number,
    value: Value,
  ): void {
    if (at >= this.times.length) this.ensure(at + 1)
    this.times[at] = time
    this.kinds[at] = kind
    this.targetKinds[at] = targetKind
    this.a[at] = a
    this.b[at] = b
    this.aux[at] = 0
    this.ops[at] = 0
    this.encodeValue(at, value)
  }

  setExtra(at: number, op: number, aux: number): void {
    this.ops[at] = op
    this.aux[at] = aux
  }

  /** The traced value of row `at`. */
  value(at: number): TracedValue {
    const num = this.valueNums[at]!
    switch (this.valueTags[at]) {
      case ValueTag.false:
        return false
      case ValueTag.true:
        return true
      case ValueTag.number:
        return num
      case ValueTag.string:
        return this.strings.text(num)
      case ValueTag.ref:
        return { ref: num }
      default:
        return null
    }
  }

  /** The write target of row `at` (for `alloc`, `list` and `cellClosed`: the object or cell). */
  target(at: number): WriteTarget {
    const a = this.a[at]!
    const b = this.b[at]!
    switch (this.targetKinds[at]) {
      case TargetCode.local:
        return { kind: 'local', frameUid: a, slot: b }
      case TargetCode.global:
        return { kind: 'global', name: this.strings.text(b) }
      case TargetCode.field:
        return { kind: 'field', objectId: a, key: this.strings.text(b) }
      case TargetCode.element:
        return { kind: 'element', objectId: a, index: b }
      case TargetCode.cell:
        return { kind: 'cell', cellId: a }
      default:
        return { kind: 'object', objectId: a }
    }
  }

  private encodeValue(at: number, value: Value): void {
    let tag: number
    let num = 0
    if (value === null) tag = ValueTag.nil
    else if (value === true) tag = ValueTag.true
    else if (value === false) tag = ValueTag.false
    else if (typeof value === 'number') {
      tag = ValueTag.number
      num = value
    } else if (typeof value === 'string') {
      tag = ValueTag.string
      num = this.strings.intern(value)
    } else {
      tag = ValueTag.ref
      num = (value as HeapObject).id
    }
    this.valueTags[at] = tag
    this.valueNums[at] = num
  }

  private ensure(needed: number): void {
    this.times = grow(this.times, needed)
    this.kinds = grow(this.kinds, needed)
    this.targetKinds = grow(this.targetKinds, needed)
    this.a = grow(this.a, needed)
    this.b = grow(this.b, needed)
    this.aux = grow(this.aux, needed)
    this.ops = grow(this.ops, needed)
    this.valueTags = grow(this.valueTags, needed)
    this.valueNums = grow(this.valueNums, needed)
  }
}

// ---------------------------------------------------------------------------------------------
// Allocation times

/** Allocation time per object id (stored as `time + 1`; 0 means "no alloc event"). */
export class AllocTimes {
  private times = new Int32Array(INITIAL_CAPACITY)

  set(id: number, time: number): void {
    if (id < 0) return
    if (id >= this.times.length) this.times = grow(this.times, id + 1)
    this.times[id] = time + 1
  }

  /** The allocation time of `id` if it is before `limit`, else null. */
  get(id: number, limit: number): number | null {
    if (!Number.isInteger(id) || id < 0 || id >= this.times.length) return null
    const stored = this.times[id]!
    return stored === 0 || stored - 1 >= limit ? null : stored - 1
  }
}
