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
import { PVec } from './pvec'
import type { ClosureObj, NativeObj, RangeObj, VMStatus } from './runtime-types'

/** A reference to the mutable object with this id. */
export class Ref {
  constructor(readonly id: number) {}
}

/**
 * Whether a frozen value is a reference. The `typeof` test first matters: `instanceof` on a
 * primitive is several times slower, and most frozen values are primitives.
 */
export function isRef(value: unknown): value is Ref {
  return typeof value === 'object' && value !== null && value instanceof Ref
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
 * full by every snapshot. A machine with several stacks would add them here and to the three walks
 * over roots: `Freezer.roots` (vm-snapshot-freeze.ts), `thawRoots` (vm-snapshot-thaw.ts) and the
 * root marking of `compactTable` (vm-snapshot.ts).
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
  return slots instanceof PVec ? slots.freshSlots(serial) : slots.length
}

/**
 * Calls `visit` with every value `object` holds (items, entries' keys and values, captures, a
 * cell's value, an iterator's source); references to other objects are the `Ref`s among them.
 */
export function forEachValue(object: FrozenObject, visit: (value: Frozen) => void): void {
  switch (object.kind) {
    case 'list':
      forEachSlot(object.items, visit)
      break
    case 'record':
      forEachSlot(object.entries, visit)
      break
    case 'closure':
      for (const cell of object.upvalues) visit(cell)
      break
    case 'cell':
      visit(object.value)
      break
    case 'iterator':
      visit(object.source)
      break
  }
}

function forEachSlot(slots: FrozenSlots, visit: (value: Frozen) => void): void {
  if (slots instanceof PVec) slots.forEach(visit)
  else for (const value of slots) visit(value)
}

/** The slots as a plain array (a copy for persistent vectors, the array itself otherwise). */
export function slotArray(slots: FrozenSlots): readonly Frozen[] {
  if (!(slots instanceof PVec)) return slots
  const out: Frozen[] = []
  slots.forEachLeaf((leaf) => {
    for (const value of leaf) out.push(value)
  })
  return out
}
