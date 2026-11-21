/**
 * Restoring a snapshot (ARCHITECTURE §6.8): rebuilds live objects from the frozen roots through the
 * snapshot's object table. Each object is created once (identity and ids preserved) as an empty
 * shell when first referenced and filled from a work list, so cycles and unlimited nesting need no
 * recursion. A full restore builds fresh objects, so a snapshot can be restored any number of
 * times. A delta restore (vm-snapshot.ts) instead starts from the live objects of the machine's
 * previous restore and refills only those that differ, in place (`Thawer.refresh`).
 */
import { InternalError } from './diagnostics'
import { PVec } from './pvec'
import type {
  CellObj,
  ClosureObj,
  Frame,
  HeapObject,
  IteratorObj,
  ListObj,
  RecordObj,
  Value,
} from './runtime-types'
import {
  type Frozen,
  type FrozenList,
  type FrozenObject,
  type FrozenRoots,
  type FrozenSlots,
  type MachineScalars,
  isRef,
  slotArray,
} from './vm-snapshot-frozen'

/** The part of the VM state a snapshot captures, as live objects. */
export interface MachineRecord extends MachineScalars {
  readonly stack: Value[]
  readonly frames: Frame[]
  readonly openCells: CellObj[]
  readonly globals: Map<string, Value>
}

/** Fresh live objects for `roots` and everything they reach in `table`. */
export function thaw(
  roots: FrozenRoots,
  table: PVec<FrozenObject>,
  scalars: MachineScalars,
): MachineRecord {
  return thawRoots(new Thawer(table), roots, scalars)
}

/** Live roots through `thawer` (which creates or reuses the objects they reach). */
export function thawRoots(
  thawer: Thawer,
  roots: FrozenRoots,
  scalars: MachineScalars,
): MachineRecord {
  const value = thawer.value
  const stack = roots.stack.map(value)
  const frames: Frame[] = roots.frames.map((frame) => ({
    closure: value(frame.closure) as ClosureObj,
    ip: frame.ip,
    base: frame.base,
    uid: frame.uid,
  }))
  const openCells = roots.openCells.map((cell) => thawer.object(cell.id) as CellObj)
  const globals = new Map<string, Value>()
  for (const [name, frozen] of roots.globals) globals.set(name, value(frozen))
  thawer.drain()
  return { ...scalars, stack, frames, openCells, globals }
}

export class Thawer {
  /** Objects still to fill (new shells or refreshed objects), each followed by its frozen copy. */
  private readonly pending: (HeapObject | FrozenObject)[] = []

  constructor(
    private readonly table: PVec<FrozenObject>,
    /** Live objects by id: reused when referenced, extended with every object created. */
    readonly live: Map<number, HeapObject> = new Map(),
  ) {}

  /** Queues a live object of the same kind to be refilled in place from `frozen`. */
  refresh(object: HeapObject, frozen: FrozenObject): void {
    this.pending.push(object, frozen)
  }

  /**
   * Sets a live list's items at `indices` (sorted; every index from the list's length on up to
   * the target's length included) from `frozen`, then cuts it to `frozen`'s length.
   */
  patch(list: HeapObject, frozen: FrozenList, indices: readonly number[]): void {
    const items = (list as ListObj).items
    const slots = frozen.items
    for (const index of indices) {
      const frozenValue = (slots instanceof PVec ? slots.get(index) : slots[index]) as Frozen
      const value = this.value(frozenValue)
      if (index < items.length) items[index] = value
      else items.push(value)
    }
    items.length = frozen.length
  }

  readonly value = (frozen: Frozen): Value => (isRef(frozen) ? this.object(frozen.id) : frozen)

  /** The live object with this id, created (empty, queued for filling) on first use. */
  object(id: number): HeapObject {
    const existing = this.live.get(id)
    if (existing !== undefined) return existing
    const frozen = this.table.get(id)
    if (frozen === undefined) throw new InternalError(`snapshot has no object ${id}`)
    const shell = this.shell(frozen)
    this.live.set(id, shell)
    this.pending.push(shell, frozen)
    return shell
  }

  drain(): void {
    const pending = this.pending
    while (pending.length > 0) {
      const frozen = pending.pop() as FrozenObject
      this.fill(pending.pop() as HeapObject, frozen)
    }
  }

  /** Live values for frozen slots, read leaf by leaf (a hot path of every seek). */
  private values(slots: FrozenSlots): Value[] {
    const out: Value[] = []
    const push = (leaf: readonly Frozen[]): void => {
      for (const frozen of leaf) out.push(isRef(frozen) ? this.object(frozen.id) : frozen)
    }
    if (slots instanceof PVec) slots.forEachLeaf(push)
    else push(slots)
    return out
  }

  /** The object with its scalar fields; references are filled in later. */
  private shell(frozen: FrozenObject): HeapObject {
    switch (frozen.kind) {
      case 'list':
        return { type: 'list', id: frozen.id, items: [] }
      case 'record':
        return { type: 'record', id: frozen.id, fields: new Map() }
      case 'closure':
        return { type: 'closure', id: frozen.id, proto: frozen.proto, upvalues: [] }
      case 'cell':
        return {
          type: 'cell',
          id: frozen.id,
          open: frozen.open,
          stackIndex: frozen.stackIndex,
          value: null,
          ownerFrameUid: frozen.ownerFrameUid,
          slot: frozen.slot,
        }
      case 'iterator':
        // The source is created now (as a shell if it is an object): the field is read-only.
        return {
          type: 'iterator',
          id: frozen.id,
          source: this.value(frozen.source),
          position: frozen.position,
          keys: frozen.keys,
        } satisfies IteratorObj
    }
  }

  /** Sets the object's contents from `frozen`, replacing what it held (refreshed objects). */
  private fill(object: HeapObject, frozen: FrozenObject): void {
    switch (frozen.kind) {
      case 'list':
        // Lists are reached through the object, never through its items array, so the array is
        // simply replaced.
        ;(object as { items: Value[] }).items = this.values(frozen.items)
        break
      case 'record': {
        const fields = (object as RecordObj).fields
        fields.clear()
        const entries = slotArray(frozen.entries)
        for (let i = 0; i < entries.length; i += 2) {
          fields.set(entries[i] as string, this.value(entries[i + 1] as Frozen))
        }
        break
      }
      case 'closure': {
        const upvalues = (object as ClosureObj).upvalues
        upvalues.length = 0
        for (const cell of frozen.upvalues) upvalues.push(this.object(cell.id) as CellObj)
        break
      }
      case 'cell': {
        const cell = object as CellObj
        cell.open = frozen.open
        cell.stackIndex = frozen.stackIndex
        cell.value = this.value(frozen.value)
        break
      }
      case 'iterator': {
        const iterator = object as Mutable<IteratorObj>
        iterator.source = this.value(frozen.source)
        iterator.position = frozen.position
        iterator.keys = frozen.keys
        break
      }
    }
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
