/**
 * Snapshots (ARCHITECTURE §6.8) with structural sharing. A snapshot holds frozen roots (stack,
 * frames, open cells, globals) and a persistent object table of frozen copies indexed by id
 * (vm-snapshot-frozen.ts). Taking one copies only what changed since the machine's previous
 * snapshot, as reported by the write barrier (vm-snapshot-freeze.ts); everything else is shared
 * with it, so consecutive snapshots cost and retain O(changes). Every snapshot is still complete on
 * its own, so dropping any of them (thinning) never invalidates another. Restoring builds fresh
 * live objects (vm-snapshot-thaw.ts) and can be repeated any number of times.
 *
 * Objects that became unreachable stay in the table until a compacting snapshot rebuilds the table
 * with only the reachable ones (reusing their copies); it happens when the table holds more than
 * twice the values it held after the last compaction, so its cost is paid for by the garbage.
 */
import type { Program } from './bytecode'
import { InternalError } from './diagnostics'
import { PVec } from './pvec'
import type { VMSnapshot } from './runtime-types'
import { Freezer } from './vm-snapshot-freeze'
import {
  type FrozenObject,
  type FrozenRoots,
  type MachineScalars,
  Ref,
  forEachValue,
  freshSize,
  objectSize,
  rootsSize,
} from './vm-snapshot-frozen'
import { type MachineRecord, thaw } from './vm-snapshot-thaw'
import type { MachineState } from './vm-state'

export type { MachineRecord } from './vm-snapshot-thaw'
export type { RecordPositions } from './vm-snapshot-freeze'

/** Compact when the table holds more than this factor times its values after the last one… */
const COMPACT_FACTOR = 2
/** …plus this many values, so small heaps never compact. */
const COMPACT_SLACK = 1 << 16

export class MachineSnapshot implements VMSnapshot {
  constructor(
    readonly program: Program,
    /**
     * The line of snapshots this one belongs to: a full snapshot starts a new line, and every
     * snapshot taken on top of a base (taken or restored) continues the base's line.
     */
    readonly lineage: symbol,
    /** Serial of this snapshot in its line: its base's serial + 1 (1 for a full one). */
    readonly serial: number,
    readonly roots: FrozenRoots,
    readonly scalars: MachineScalars,
    readonly table: PVec<FrozenObject>,
    /** The values this snapshot copied: roots, objects or their changed leaves, table slots. */
    readonly size: number,
    /** The values held by all objects in the table. */
    readonly tableValues: number,
    /** The table's values after the last compaction. */
    readonly compactedValues: number,
  ) {}

  get time(): number {
    return this.scalars.time
  }

  get nextObjectId(): number {
    return this.scalars.nextObjectId
  }

  /**
   * The values this snapshot holds that `earlier` does not share: everything for null, else what
   * was copied after `earlier`. Sharing is counted only when `earlier` is in the same line with a
   * smaller serial, which callers keep to ancestors (the recorder's snapshots form a chain); for
   * anything else the whole snapshot counts.
   */
  retainedSince(earlier: VMSnapshot | null): number {
    const after =
      earlier instanceof MachineSnapshot &&
      earlier.lineage === this.lineage &&
      earlier.serial < this.serial
        ? earlier.serial
        : 0
    let count = rootsSize(this.roots)
    this.table.freshNodes(after, (node, leaf) => {
      // The table's own slots count too: they cost as much as values.
      count += node.slots.length
      if (!leaf) return
      for (const object of node.slots) {
        if (object !== undefined) count += freshSize(object as FrozenObject, after)
      }
    })
    return count
  }

  /** Fresh live objects for the state this snapshot holds. */
  thaw(): MachineRecord {
    return thaw(this.roots, this.table, this.scalars)
  }
}

/** Snapshots the machine's state, sharing with its base, and makes the result the new base. */
export function takeSnapshot(m: MachineState): MachineSnapshot {
  const base = m.base
  const serial = (base?.serial ?? 0) + 1
  const freezer = new Freezer(m, serial)
  if (base !== null) freezer.applyChanges(m.changeLog)
  const roots = freezer.roots()
  freezer.drain()
  let table = freezer.table.build()
  let tableValues = freezer.tableValues
  let size = freezer.copied + freezer.table.copied
  let compacted = base === null ? tableValues : base.compactedValues
  if (tableValues > COMPACT_FACTOR * compacted + COMPACT_SLACK) {
    const result = compactTable(table, roots, serial)
    table = result.table
    tableValues = result.values
    // A compaction stores a new table slot for every reachable object.
    size += result.objects
    compacted = tableValues
  }
  const snapshot = new MachineSnapshot(
    m.program,
    base?.lineage ?? Symbol('snapshot line'),
    serial,
    roots,
    scalarsOf(m),
    table,
    size,
    tableValues,
    compacted,
  )
  m.trackFrom(snapshot)
  return snapshot
}

/** Replaces the machine's state with fresh objects for `snapshot`, which becomes its base. */
export function restoreSnapshot(m: MachineState, snapshot: MachineSnapshot): void {
  const record = snapshot.thaw()
  m.stack = record.stack
  m.frames = record.frames
  m.openCells = record.openCells
  m.globals = record.globals
  m.time = record.time
  m.nextObjectId = record.nextObjectId
  m.nextFrameUid = record.nextFrameUid
  m.rngState = record.rngState
  m.allocated = record.allocated
  m.scanned = record.scanned
  m.status = record.status
  m.error = record.error
  m.positions.clear()
  m.trackFrom(snapshot)
}

function scalarsOf(m: MachineState): MachineScalars {
  return {
    time: m.time,
    nextObjectId: m.nextObjectId,
    nextFrameUid: m.nextFrameUid,
    rngState: m.rngState,
    allocated: m.allocated,
    scanned: m.scanned,
    status: m.status,
    error: m.error,
  }
}

/**
 * A table with only the objects reachable from `roots` (their copies reused). Marks live in a
 * bitset over the table's ids, so the new table is built in id order without sorting.
 */
function compactTable(
  table: PVec<FrozenObject>,
  roots: FrozenRoots,
  serial: number,
): { table: PVec<FrozenObject>; values: number; objects: number } {
  const marks = new Uint32Array((table.length + 31) >>> 5)
  const work: number[] = []
  const mark = (value: unknown): void => {
    if (!(value instanceof Ref)) return
    const id = value.id
    const bit = 1 << (id & 31)
    const word = id >>> 5
    if ((marks[word]! & bit) === 0) {
      marks[word] = marks[word]! | bit
      work.push(id)
    }
  }
  roots.stack.forEach(mark)
  for (const frame of roots.frames) mark(frame.closure)
  roots.openCells.forEach(mark)
  roots.globals.forEach(mark)
  while (work.length > 0) {
    const id = work.pop()!
    const object = table.get(id)
    if (object === undefined) throw new InternalError(`snapshot has no object ${id}`)
    forEachValue(object, mark)
  }
  const editor = PVec.empty<FrozenObject>().edit(serial)
  let values = 0
  let objects = 0
  for (let word = 0; word < marks.length; word++) {
    let bits = marks[word]!
    while (bits !== 0) {
      const low = bits & -bits
      const id = (word << 5) + 31 - Math.clz32(low)
      bits ^= low
      const object = table.get(id)!
      editor.set(id, object)
      values += objectSize(object)
      objects++
    }
  }
  return { table: editor.build(), values, objects }
}
