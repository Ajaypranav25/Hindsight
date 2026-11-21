/**
 * The immutable form of VM state inside snapshots (ARCHITECTURE §6.8). Every mutable heap object
 * is stored as a frozen copy in an object table indexed by id, and frozen copies refer to other
 * mutable objects by id (`Ref`), never by pointer, so a copy stays valid when its children change
 * and consecutive snapshots can share every copy that did not change. Strings, numbers, ranges,
 * natives and library closures are immutable and stored as they are.
 *
 * Large lists and records keep their contents in persistent vectors, so a change to one element
 * copies one 32-slot leaf (plus the path to it) instead of the whole object.
 */
import type { RuntimeErrorInfo } from './api-types'
import type { FunctionProto } from './bytecode'
import { type PNode, PVec } from './pvec'
import type { ClosureObj, NativeObj, RangeObj, VMStatus } from './runtime-types'

/** A reference to the mutable object with this id. */
export class Ref {
  constructor(readonly id: number) {}
}

/** A value inside a snapshot: primitives and shared objects as they are, other objects by id. */
export type Frozen = null | boolean | number | string | RangeObj | NativeObj | ClosureObj | Ref

/** Contents of up to SMALL_SLOTS values in a plain array, larger ones in a persistent vector. */
export type FrozenSlots = readonly Frozen[] | PVec<Frozen>

/** Lists with at most this many items (records with half as many entries) use plain arrays. */
export const SMALL_SLOTS = 32

export class FrozenList {
  readonly kind = 'list'
  constructor(
    readonly id: number,
    readonly birth: number,
    readonly items: FrozenSlots,
    readonly length: number,
  ) {}
}

/** Entries in insertion order, flattened: `[key0, value0, key1, value1, …]`. */
export class FrozenRecord {
  readonly kind = 'record'
  constructor(
    readonly id: number,
    readonly birth: number,
    readonly entries: FrozenSlots,
    /** Number of entries. */
    readonly length: number,
  ) {}
}

export class FrozenClosure {
  readonly kind = 'closure'
  constructor(
    readonly id: number,
    readonly birth: number,
    readonly proto: FunctionProto,
    readonly upvalues: readonly Ref[],
  ) {}
}

export class FrozenCell {
  readonly kind = 'cell'
  constructor(
    readonly id: number,
    readonly birth: number,
    readonly open: boolean,
    readonly stackIndex: number,
    readonly value: Frozen,
    readonly ownerFrameUid: number,
    readonly slot: number,
  ) {}
}

export class FrozenIterator {
  readonly kind = 'iterator'
  constructor(
    readonly id: number,
    readonly birth: number,
    readonly source: Frozen,
    readonly position: number,
    readonly keys: readonly string[] | null,
  ) {}
}

export type FrozenObject = FrozenList | FrozenRecord | FrozenClosure | FrozenCell | FrozenIterator

export interface FrozenFrame {
  /** A `Ref` to a user closure, or a library closure itself. */
  readonly closure: Frozen
  readonly ip: number
  readonly base: number
  readonly uid: number
}

/**
 * The roots of the machine: everything outside the heap that refers into it. Roots are copied in
 * full by every snapshot. A machine with several stacks would add them here and to the helpers in
 * vm-snapshot-freeze.ts and vm-snapshot-thaw.ts that walk roots.
 */
export interface FrozenRoots {
  readonly stack: readonly Frozen[]
  readonly frames: readonly FrozenFrame[]
  readonly openCells: readonly Ref[]
  readonly globals: ReadonlyMap<string, Frozen>
}

/** The scalar part of the machine record. */
export interface MachineScalars {
  readonly time: number
  readonly nextObjectId: number
  readonly nextFrameUid: number
  readonly rngState: number
  readonly allocated: number
  readonly scanned: number
  readonly status: VMStatus
  readonly error: RuntimeErrorInfo | null
}

export function rootsSize(roots: FrozenRoots): number {
  return roots.stack.length + roots.frames.length + roots.openCells.length + roots.globals.size
}

/** The values an object holds: one for the object itself plus one per item, entry or capture. */
export function objectSize(object: FrozenObject): number {
  switch (object.kind) {
    case 'list':
    case 'record':
      return 1 + object.length
    case 'closure':
      return 1 + object.upvalues.length
    case 'cell':
      return 2
    case 'iterator':
      return 1
  }
}

/**
 * The values of `object` stored after snapshot `serial`: none when the copy itself is older, else
 * the object plus the contents it did not share with older copies.
 */
export function freshSize(object: FrozenObject, serial: number): number {
  if (object.birth <= serial) return 0
  switch (object.kind) {
    case 'list':
      return 1 + freshSlots(object.items, serial)
    case 'record':
      return 1 + Math.ceil(freshSlots(object.entries, serial) / 2)
    default:
      return objectSize(object)
  }
}

function freshSlots(slots: FrozenSlots, serial: number): number {
  if (!(slots instanceof PVec)) return slots.length
  let count = 0
  slots.freshLeaves(serial, (leaf: PNode) => {
    count += leaf.slots.length
  })
  return count
}

/** Calls `visit` with the id of every object `object` refers to. */
export function forEachRef(object: FrozenObject, visit: (id: number) => void): void {
  const check = (value: unknown): void => {
    if (value instanceof Ref) visit(value.id)
  }
  switch (object.kind) {
    case 'list':
      forEachSlot(object.items, check)
      break
    case 'record':
      forEachSlot(object.entries, check)
      break
    case 'closure':
      for (const cell of object.upvalues) visit(cell.id)
      break
    case 'cell':
      check(object.value)
      break
    case 'iterator':
      check(object.source)
      break
  }
}

function forEachSlot(slots: FrozenSlots, visit: (value: Frozen) => void): void {
  if (slots instanceof PVec) slots.toArray(visit)
  else for (const value of slots) visit(value)
}

/** The slots as a plain array (a copy for persistent vectors, the array itself otherwise). */
export function slotArray<T>(slots: FrozenSlots, map: (value: Frozen) => T): T[] {
  return slots instanceof PVec ? slots.toArray(map) : slots.map(map)
}
