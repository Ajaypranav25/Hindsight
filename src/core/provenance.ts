/**
 * Provenance queries (ARCHITECTURE §7.3): `origin` (the latest event that produced a target's value
 * before a time) and `history` (the events of the binding live at a time, windowed and sampled).
 */
import type { HistoryResult, HistoryWindow, ProvenanceEvent, WriteTarget } from './api-types'
import { type CellInfo, type ProvenanceIndex, countBefore } from './provenance-index'
import { EventCode, ListOpCode, TargetCode, type StepColumns } from './trace-columns'

const DEFAULT_HISTORY_LIMIT = 1000

/** The latest row in `rows` with time `< before` that `accept`s, or -1. */
function latestRow(
  index: ProvenanceIndex,
  rows: readonly number[],
  before: number,
  accept: (row: number) => boolean = () => true,
): number {
  for (let p = countBefore(index, rows, before) - 1; p >= 0; p--) {
    if (accept(rows[p]!)) return rows[p]!
  }
  return -1
}

function eventOrNull(index: ProvenanceIndex, row: number): ProvenanceEvent | null {
  return row < 0 ? null : index.event(row)
}

export function origin(
  index: ProvenanceIndex,
  target: WriteTarget,
  before: number,
): ProvenanceEvent | null {
  switch (target.kind) {
    case 'local':
      return eventOrNull(
        index,
        latestRow(index, index.localRows(target.frameUid, target.slot), before),
      )
    case 'global':
      return eventOrNull(index, latestRow(index, globalRows(index, target.name), before))
    case 'object':
      return eventOrNull(index, latestRow(index, index.byObject.get(target.objectId) ?? [], before))
    case 'field':
      return eventOrNull(index, fieldOrigin(index, target.objectId, target.key, before))
    case 'element': {
      const rows = elementChain(index, target.objectId, target.index, before, true)
      return eventOrNull(index, rows.length > 0 ? rows[0]! : -1)
    }
    default:
      return eventOrNull(index, cellOrigin(index, target.cellId, before))
  }
}

function globalRows(index: ProvenanceIndex, name: string): readonly number[] {
  const id = index.events.strings.find(name)
  return id < 0 ? [] : (index.byGlobal.get(id) ?? [])
}

function isFieldRow(index: ProvenanceIndex, row: number, keyId: number): boolean {
  const events = index.events
  return events.targetKinds[row] === TargetCode.field && events.b[row] === keyId
}

function fieldOrigin(
  index: ProvenanceIndex,
  objectId: number,
  key: string,
  before: number,
): number {
  const rows = index.byObject.get(objectId) ?? []
  const keyId = index.events.strings.find(key)
  const write =
    keyId < 0 ? -1 : latestRow(index, rows, before, (row) => isFieldRow(index, row, keyId))
  if (write >= 0) return write
  return latestRow(index, rows, before, (row) => index.kind(row) === EventCode.alloc)
}

/**
 * The events that produced element `elementIndex` of a list as seen at `before`, newest first,
 * walking back through shape changes with the index translation of §7.3. With `firstOnly` the walk
 * stops at the first (latest) such event.
 */
function elementChain(
  index: ProvenanceIndex,
  listId: number,
  elementIndex: number,
  before: number,
  firstOnly: boolean,
): number[] {
  const rows = index.byObject.get(listId) ?? []
  const { kinds, targetKinds, b, ops, aux } = index.events
  const found: number[] = []
  let i = elementIndex
  for (let p = countBefore(index, rows, before) - 1; p >= 0; p--) {
    const row = rows[p]!
    const kind = kinds[row]!
    if (kind === EventCode.alloc) {
      found.push(row)
      break
    }
    if (kind === EventCode.write && targetKinds[row] === TargetCode.element && b[row] === i) {
      found.push(row)
      if (firstOnly) break
      continue
    }
    if (kind !== EventCode.list) continue
    const at = b[row]!
    const op = ops[row]!
    if (
      op === ListOpCode.extend
        ? at <= i && i < at + aux[row]!
        : op !== ListOpCode.remove && op !== ListOpCode.pop && at === i
    ) {
      found.push(row)
      break
    }
    if (op === ListOpCode.insert && at < i) i--
    else if (op === ListOpCode.remove && at <= i) i++
  }
  return found
}

/**
 * Element writes after `after` that still address the same element, following it forward through
 * inserts and removes until it leaves the list.
 */
function elementFuture(
  index: ProvenanceIndex,
  listId: number,
  elementIndex: number,
  after: number,
): number[] {
  const rows = index.byObject.get(listId) ?? []
  const { kinds, targetKinds, b, ops } = index.events
  const found: number[] = []
  let i = elementIndex
  for (let p = countBefore(index, rows, after); p < rows.length; p++) {
    const row = rows[p]!
    const kind = kinds[row]!
    if (kind === EventCode.write && targetKinds[row] === TargetCode.element && b[row] === i) {
      found.push(row)
      continue
    }
    if (kind !== EventCode.list) continue
    const at = b[row]!
    const op = ops[row]!
    if (op === ListOpCode.insert && at <= i) i++
    else if (op === ListOpCode.remove && at < i) i--
    else if ((op === ListOpCode.remove || op === ListOpCode.pop) && at === i) break
  }
  return found
}

function cellOrigin(index: ProvenanceIndex, cellId: number, before: number): number {
  const write = latestRow(index, index.byCell.get(cellId) ?? [], before)
  const info = index.cells.get(cellId)
  if (info === undefined) return write
  const limit = info.closeTime >= 0 ? Math.min(before, info.closeTime) : before
  const local = latestRow(index, index.localRows(info.ownerFrameUid, info.slot), limit)
  return Math.max(write, local)
}

// ---------------------------------------------------------------------------------------------
// History

export function history(
  index: ProvenanceIndex,
  steps: StepColumns,
  length: number,
  target: WriteTarget,
  at: number,
  window: HistoryWindow = {},
): HistoryResult {
  const rows = historyRows(index, steps, target, at)
  const from = window.from ?? 0
  const to = window.to ?? length
  const inWindow = rows.filter((row) => {
    const time = index.time(row)
    return time >= from && time < to
  })
  const limit = Math.max(0, Math.floor(window.limit ?? DEFAULT_HISTORY_LIMIT))
  const total = inWindow.length
  const picked = total > limit ? sample(inWindow, limit) : inWindow
  return { events: picked.map((row) => index.event(row)), total, truncated: total > limit }
}

/** `limit` evenly spaced items, the first and the last included. */
function sample(rows: readonly number[], limit: number): number[] {
  if (limit === 0) return []
  if (limit === 1) return [rows[0]!]
  const picked: number[] = []
  const step = (rows.length - 1) / (limit - 1)
  for (let k = 0; k < limit; k++) picked.push(rows[Math.round(k * step)]!)
  return picked
}

function historyRows(
  index: ProvenanceIndex,
  steps: StepColumns,
  target: WriteTarget,
  at: number,
): number[] {
  switch (target.kind) {
    case 'local':
      return bindingRows(index, steps, target.frameUid, target.slot, at)
    case 'cell': {
      const info = index.cells.get(target.cellId)
      if (info === undefined) return (index.byCell.get(target.cellId) ?? []).slice()
      const anchor = info.closeTime >= 0 && info.closeTime < at ? info.closeTime : at
      return bindingRows(index, steps, info.ownerFrameUid, info.slot, anchor)
    }
    case 'global':
      return globalRows(index, target.name).slice()
    case 'object':
      return (index.byObject.get(target.objectId) ?? []).slice()
    case 'field': {
      const keyId = index.events.strings.find(target.key)
      const rows = index.byObject.get(target.objectId) ?? []
      return rows.filter(
        (row) =>
          index.kind(row) === EventCode.alloc || (keyId >= 0 && isFieldRow(index, row, keyId)),
      )
    }
    default: {
      const past = elementChain(index, target.objectId, target.index, at, false).reverse()
      return past.concat(elementFuture(index, target.objectId, target.index, at))
    }
  }
}

/**
 * The binding of `(frameUid, slot)` live at `at`: every occupancy of the slot whose declaration ran
 * at the same site as the latest declaration before `at`, plus the events of cells that captured
 * such an occupancy and were closed.
 */
function bindingRows(
  index: ProvenanceIndex,
  steps: StepColumns,
  frameUid: number,
  slot: number,
  at: number,
): number[] {
  const rows = index.localRows(frameUid, slot)
  const isDeclare = (row: number): boolean => index.kind(row) === EventCode.declare
  const anchor = latestRow(index, rows, at, isDeclare)
  if (anchor < 0) return []
  const site = siteOf(index, steps, anchor)
  const sameSite = (declareRow: number): boolean => siteOf(index, steps, declareRow) === site
  const result: number[] = []
  let included = false
  for (const row of rows) {
    if (isDeclare(row)) included = sameSite(row)
    if (included) result.push(row)
  }
  const cells = (index.cellsByFrame.get(frameUid) ?? []).filter(
    (cell) => cell.slot === slot && cellBelongs(index, rows, cell, isDeclare, sameSite),
  )
  if (cells.length === 0) return result
  for (const cell of cells) result.push(...(index.byCell.get(cell.cellId) ?? []))
  return result.sort((x, y) => x - y)
}

function cellBelongs(
  index: ProvenanceIndex,
  rows: readonly number[],
  cell: CellInfo,
  isDeclare: (row: number) => boolean,
  sameSite: (row: number) => boolean,
): boolean {
  if (cell.closeTime < 0) return false
  const declareRow = latestRow(index, rows, cell.closeTime, isDeclare)
  return declareRow >= 0 && sameSite(declareRow)
}

/** The declaration site (proto id, ip) of the instruction that emitted a row, as one number. */
function siteOf(index: ProvenanceIndex, steps: StepColumns, row: number): number {
  const time = index.time(row)
  return steps.protoIds[time]! * 0x1000000 + steps.ips[time]!
}
