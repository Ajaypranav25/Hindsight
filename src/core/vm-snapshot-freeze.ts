/**
 * Taking a snapshot (ARCHITECTURE §6.8): new frozen copies for the objects that changed since the
 * machine's base snapshot (from its change log) and for the reachable objects created since, on
 * top of the base snapshot's object table; everything else is shared with the base.
 *
 * Objects created after the base can only be reached through the roots, through objects that
 * changed, or through other new objects, because an unchanged old object still holds exactly the
 * references it held then. So a walk that starts at the roots and at the changed parts of changed
 * objects, and descends only into new objects, finds every new object still reachable (garbage
 * created and dropped between two snapshots is never copied). Without a base every object counts
 * as new, which makes the same walk a full copy. The walk uses an explicit work list.
 */
import { InternalError } from './diagnostics'
import { PVec, type PVecEditor } from './pvec'
import type {
  CellObj,
  ClosureObj,
  HeapObject,
  IteratorObj,
  ListObj,
  RecordObj,
  Value,
} from './runtime-types'
import {
  type Frozen,
  FrozenCell,
  FrozenClosure,
  FrozenIterator,
  FrozenList,
  type FrozenObject,
  FrozenRecord,
  type FrozenRoots,
  type FrozenSlots,
  Ref,
  SMALL_SLOTS,
  objectSize,
  slotArray,
} from './vm-snapshot-frozen'
import type { MachineState } from './vm-state'

/** Key positions of a large record's entries in one frozen version of it (per machine). */
export interface RecordPositions {
  readonly version: FrozenRecord
  readonly positions: Map<string, number>
}

/** What the change log says about one object. */
interface Change {
  /** Lists: element indices written. */
  readonly points: number[]
  /** Lists: the smallest index from which the tail changed (Infinity: none). */
  tail: number
  /** Records: keys written, in order (repeats allowed). */
  readonly keys: string[]
  /** Records: a key was deleted, so entries moved. */
  deleted: boolean
}

export class Freezer {
  readonly table: PVecEditor<FrozenObject>
  /** Values stored afresh: roots, object headers and the contents copied. */
  copied = 0
  /** The values held by all objects in the table being built. */
  tableValues: number
  /** Objects with ids at or above this were created after the base. */
  private readonly newFrom: number
  private readonly baseTable: PVec<FrozenObject>
  private readonly queued = new Set<HeapObject>()
  private readonly pending: HeapObject[] = []

  constructor(
    private readonly m: MachineState,
    private readonly serial: number,
  ) {
    const base = m.base
    this.baseTable = base === null ? PVec.empty() : base.table
    this.table = this.baseTable.edit(serial)
    this.tableValues = base === null ? 0 : base.tableValues
    this.newFrom = base === null ? 0 : base.nextObjectId
  }

  /** The frozen form of a value, queueing new objects for copying. */
  readonly freeze = (value: Value): Frozen => {
    if (typeof value !== 'object' || value === null) return value
    switch (value.type) {
      case 'range':
      case 'native':
        return value
      case 'closure':
        if (value.id < 0) return value
        break
      default:
        break
    }
    if (value.id >= this.newFrom && !this.queued.has(value)) {
      this.queued.add(value)
      this.pending.push(value)
    }
    return this.ref(value.id)
  }

  /** Copies the changed parts of the objects in the change log `(object, detail)` pairs. */
  applyChanges(log: readonly unknown[]): void {
    const changes = new Map<HeapObject, Change>()
    for (let i = 0; i < log.length; i += 2) {
      const object = log[i] as HeapObject
      // Objects created after the base are copied whole by the walk if still reachable.
      if (object.id >= this.newFrom) continue
      let change = changes.get(object)
      if (change === undefined) {
        change = { points: [], tail: Infinity, keys: [], deleted: false }
        changes.set(object, change)
      }
      const detail = log[i + 1] as number | string | null
      if (typeof detail === 'number') {
        if (detail >= 0) change.points.push(detail)
        else change.tail = Math.min(change.tail, -1 - detail)
      } else if (detail === null) {
        change.deleted = true
      } else {
        change.keys.push(detail)
      }
    }
    for (const [object, change] of changes) this.reissue(object, change)
  }

  /** The frozen roots of the machine (always copied in full). */
  roots(): FrozenRoots {
    const m = this.m
    const freeze = this.freeze
    const globals = new Map<string, Frozen>()
    for (const [name, value] of m.globals) globals.set(name, freeze(value))
    const roots: FrozenRoots = {
      stack: m.stack.map(freeze),
      frames: m.frames.map((frame) => ({
        closure: freeze(frame.closure),
        ip: frame.ip,
        base: frame.base,
        uid: frame.uid,
      })),
      openCells: m.openCells.map((cell) => freeze(cell) as Ref),
      globals,
    }
    this.copied +=
      roots.stack.length + roots.frames.length + roots.openCells.length + roots.globals.size
    return roots
  }

  /** Copies every queued new object, and the new objects they refer to. */
  drain(): void {
    const pending = this.pending
    while (pending.length > 0) {
      const object = pending.pop()!
      this.store(this.copyOf(object), 0)
    }
  }

  private ref(id: number): Ref {
    const refs = this.m.refs
    return (refs[id] ??= new Ref(id))
  }

  /** Puts a new copy in the table; `previousSize` is the size of the copy it replaces. */
  private store(copy: FrozenObject, previousSize: number): void {
    this.table.set(copy.id, copy)
    this.tableValues += objectSize(copy) - previousSize
  }

  /** A new version of an old object that changed in place. */
  private reissue(object: HeapObject, change: Change): void {
    const previous = this.baseTable.get(object.id)
    if (previous === undefined) {
      throw new InternalError(`object ${object.id} changed but is not in the base snapshot`)
    }
    let copy: FrozenObject | null = null
    if (object.type === 'list' && previous.kind === 'list') {
      copy = this.reissueList(object, previous, change)
    } else if (object.type === 'record' && previous.kind === 'record' && !change.deleted) {
      copy = this.reissueRecord(object, previous, change)
    }
    this.store(copy ?? this.copyOf(object), objectSize(previous))
  }

  /** Copies only the leaves of a large list that changed; null when a whole copy is simpler. */
  private reissueList(list: ListObj, previous: FrozenList, change: Change): FrozenList | null {
    const items = list.items
    const length = items.length
    if (length <= SMALL_SLOTS || !(previous.items instanceof PVec)) return null
    const editor = previous.items.edit(this.serial)
    const tail = Math.min(change.tail, length)
    editor.truncate(tail)
    for (const index of change.points) {
      if (index < tail) editor.set(index, this.freeze(items[index] as Value))
    }
    for (let i = editor.length; i < length; i++) editor.push(this.freeze(items[i] as Value))
    this.copied += 1 + editor.copied
    return new FrozenList(list.id, this.serial, editor.build(), length)
  }

  /**
   * Copies only the leaves of a large record whose entries were written (new keys go at the end,
   * as in the live record); null when a whole copy is simpler.
   */
  private reissueRecord(
    record: RecordObj,
    previous: FrozenRecord,
    change: Change,
  ): FrozenRecord | null {
    const fields = record.fields
    if (fields.size <= SMALL_SLOTS / 2 || !(previous.entries instanceof PVec)) return null
    // The cached positions are updated in place below, so a failed attempt must drop them.
    const positions = this.positionsOf(previous)
    this.m.positions.delete(record.id)
    const editor = previous.entries.edit(this.serial)
    let length = previous.length
    const done = new Set<string>()
    for (const key of change.keys) {
      if (done.has(key)) continue
      done.add(key)
      const value = fields.get(key)
      if (value === undefined) return null
      let position = positions.get(key)
      if (position === undefined) {
        position = length++
        positions.set(key, position)
        editor.set(2 * position, key)
      }
      editor.set(2 * position + 1, this.freeze(value))
    }
    if (length !== fields.size) return null
    this.copied += 1 + Math.ceil(editor.copied / 2)
    const copy = new FrozenRecord(record.id, this.serial, editor.build(), length)
    this.m.positions.set(record.id, { version: copy, positions })
    return copy
  }

  /** The key positions of `version`, cached per machine while it stays the latest version. */
  private positionsOf(version: FrozenRecord): Map<string, number> {
    const cached = this.m.positions.get(version.id)
    if (cached !== undefined && cached.version === version) return cached.positions
    const positions = new Map<string, number>()
    const entries = slotArray(version.entries, (value) => value)
    for (let i = 0; i < entries.length; i += 2) positions.set(entries[i] as string, i / 2)
    return positions
  }

  /** A whole copy of `object`. */
  private copyOf(object: HeapObject): FrozenObject {
    const serial = this.serial
    switch (object.type) {
      case 'list':
        this.copied += 1 + object.items.length
        return new FrozenList(object.id, serial, this.slots(object.items), object.items.length)
      case 'record':
        return this.copyRecord(object)
      case 'closure':
        return this.copyClosure(object)
      case 'cell':
        return this.copyCell(object)
      case 'iterator':
        return this.copyIterator(object)
      default:
        throw new InternalError(`cannot copy ${object.type}`)
    }
  }

  private slots(values: readonly Value[]): FrozenSlots {
    return values.length <= SMALL_SLOTS
      ? values.map(this.freeze)
      : PVec.from(values, this.serial, this.freeze)
  }

  private copyRecord(record: RecordObj): FrozenRecord {
    const entries: Value[] = []
    for (const [key, value] of record.fields) entries.push(key, value)
    this.copied += 1 + record.fields.size
    return new FrozenRecord(record.id, this.serial, this.slots(entries), record.fields.size)
  }

  private copyClosure(closure: ClosureObj): FrozenClosure {
    const upvalues = closure.upvalues.map((cell) => this.freeze(cell) as Ref)
    this.copied += 1 + upvalues.length
    return new FrozenClosure(closure.id, this.serial, closure.proto, upvalues)
  }

  private copyCell(cell: CellObj): FrozenCell {
    this.copied += 2
    const value = this.freeze(cell.value)
    return new FrozenCell(
      cell.id,
      this.serial,
      cell.open,
      cell.stackIndex,
      value,
      cell.ownerFrameUid,
      cell.slot,
    )
  }

  private copyIterator(iterator: IteratorObj): FrozenIterator {
    this.copied += 1
    const source = this.freeze(iterator.source)
    return new FrozenIterator(iterator.id, this.serial, source, iterator.position, iterator.keys)
  }
}
