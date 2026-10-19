/**
 * The per-target event index behind provenance queries (ARCHITECTURE §7.3), built once per recording
 * from the columnar event log, and the decoding of rows into `ProvenanceEvent`s.
 */
import type { ProvenanceEvent } from './api-types'
import { AllocType, EventCode, type EventColumns, LIST_OPS, TargetCode } from './trace-columns'

export interface CellInfo {
  readonly cellId: number
  readonly ownerFrameUid: number
  readonly slot: number
  /** Time of the `cellClosed` event, or -1 while open for the whole recording. */
  closeTime: number
}

function pushTo<K>(map: Map<K, number[]>, key: K, row: number): void {
  const rows = map.get(key)
  if (rows === undefined) map.set(key, [row])
  else rows.push(row)
}

const EVENT_KINDS = ['declare', 'write', 'alloc', 'list', 'delete'] as const

export class ProvenanceIndex {
  /** Rows of `declare`/`write` events on locals, by frame uid. */
  readonly byFrame = new Map<number, number[]>()
  /** Rows of events on globals, by name id. */
  readonly byGlobal = new Map<number, number[]>()
  /** Rows of every event on an object (alloc, fields, elements, list ops, deletes), by id. */
  readonly byObject = new Map<number, number[]>()
  /** Rows of writes to closed cells, by cell id. */
  readonly byCell = new Map<number, number[]>()
  readonly cells = new Map<number, CellInfo>()
  /** Cells by owner frame uid. */
  readonly cellsByFrame = new Map<number, CellInfo[]>()

  constructor(
    readonly events: EventColumns,
    readonly count: number,
  ) {
    const { kinds, targetKinds, a, b } = events
    for (let row = 0; row < count; row++) {
      const kind = kinds[row]!
      if (kind === EventCode.cellClosed) {
        this.cellClosed(row)
        continue
      }
      if (kind === EventCode.alloc && events.ops[row] === AllocType.cell) this.cellAllocated(row)
      switch (targetKinds[row]) {
        case TargetCode.local:
          pushTo(this.byFrame, a[row]!, row)
          break
        case TargetCode.global:
          pushTo(this.byGlobal, b[row]!, row)
          break
        case TargetCode.cell:
          pushTo(this.byCell, a[row]!, row)
          break
        default:
          pushTo(this.byObject, a[row]!, row)
      }
    }
  }

  time(row: number): number {
    return this.events.times[row]!
  }

  kind(row: number): number {
    return this.events.kinds[row]!
  }

  /** The rows of `(frameUid, slot)`. */
  localRows(frameUid: number, slot: number): number[] {
    const rows = this.byFrame.get(frameUid) ?? []
    const b = this.events.b
    return rows.filter((row) => b[row] === slot)
  }

  event(row: number): ProvenanceEvent {
    const events = this.events
    const kind = events.kinds[row]!
    const base = {
      time: events.times[row]!,
      kind: EVENT_KINDS[kind]!,
      target: events.target(row),
      value: events.value(row),
    }
    if (kind !== EventCode.list) return base
    return {
      ...base,
      op: LIST_OPS[events.ops[row]!]!,
      index: events.b[row]!,
      count: events.aux[row]!,
    }
  }

  private cellAllocated(row: number): void {
    const info: CellInfo = {
      cellId: this.events.a[row]!,
      ownerFrameUid: this.events.aux[row]!,
      slot: this.events.b[row]!,
      closeTime: -1,
    }
    this.cells.set(info.cellId, info)
    const owned = this.cellsByFrame.get(info.ownerFrameUid)
    if (owned === undefined) this.cellsByFrame.set(info.ownerFrameUid, [info])
    else owned.push(info)
  }

  private cellClosed(row: number): void {
    const info = this.cells.get(this.events.a[row]!)
    if (info !== undefined) info.closeTime = this.events.times[row]!
  }
}

/** Number of rows in `rows` (ascending by time) whose time is `< before`. */
export function countBefore(
  index: ProvenanceIndex,
  rows: readonly number[],
  before: number,
): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (index.time(rows[mid]!) < before) lo = mid + 1
    else hi = mid
  }
  return lo
}
