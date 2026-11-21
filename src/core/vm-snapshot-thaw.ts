/**
 * Restoring a snapshot (ARCHITECTURE §6.8): rebuilds live objects from the frozen roots through the
 * snapshot's object table. Each object is created once (identity and ids preserved) as an empty
 * shell when first referenced and filled from a work list, so cycles and unlimited nesting need no
 * recursion. Every call builds fresh objects, so a snapshot can be restored any number of times.
 */
import { InternalError } from './diagnostics'
import type { PVec } from './pvec'
import type {
  CellObj,
  ClosureObj,
  Frame,
  HeapObject,
  IteratorObj,
  RecordObj,
  Value,
} from './runtime-types'
import {
  type Frozen,
  type FrozenObject,
  type FrozenRoots,
  type MachineScalars,
  Ref,
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
  const thawer = new Thawer(table)
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

class Thawer {
  private readonly live = new Map<number, HeapObject>()
  /** Shells still to fill, each followed by its frozen copy. */
  private readonly pending: (HeapObject | FrozenObject)[] = []

  constructor(private readonly table: PVec<FrozenObject>) {}

  readonly value = (frozen: Frozen): Value =>
    frozen instanceof Ref ? this.object(frozen.id) : frozen

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

  private fill(object: HeapObject, frozen: FrozenObject): void {
    switch (frozen.kind) {
      case 'list':
        // The shell's empty array is not shared with anything yet, so it is simply replaced.
        ;(object as { items: Value[] }).items = slotArray(frozen.items, this.value)
        break
      case 'record': {
        const fields = (object as RecordObj).fields
        const entries = slotArray(frozen.entries, (value) => value)
        for (let i = 0; i < entries.length; i += 2) {
          fields.set(entries[i] as string, this.value(entries[i + 1] as Frozen))
        }
        break
      }
      case 'closure': {
        const upvalues = (object as ClosureObj).upvalues
        for (const cell of frozen.upvalues) upvalues.push(this.object(cell.id) as CellObj)
        break
      }
      case 'cell':
        ;(object as CellObj).value = this.value(frozen.value)
        break
      default:
        break
    }
  }
}
