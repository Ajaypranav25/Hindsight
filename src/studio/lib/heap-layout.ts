/**
 * Heap graph layout (pure). Roots (variables) form a column of chips on the left; objects form
 * columns by breadth-first distance from the roots. A small memory keyed by object id keeps boxes
 * in place as the pen moves (ARCHITECTURE §11.3, "Heap").
 */
import type {
  CaptureView,
  FrameView,
  GlobalView,
  ObjectView,
  ValueView,
} from '../../core/api-types'
import { formatValue, truncate } from './format'

export const MAX_BOXES = 60
export const MAX_LIST_CELLS = 12
export const MAX_RECORD_ROWS = 10
export const CHAR_W = 6.8
export const ROW_H = 20
export const HEADER_H = 20
export const CHIP_H = 22
export const CHIP_GAP = 4
export const GROUP_LABEL_H = 18
export const COL_GAP = 64
export const BOX_GAP = 18
export const MARGIN = 24
export const PAD_X = 8
const MIN_BOX_W = 96
const WIDTH_STEP = 24
const MAX_LABEL_CHARS = 12
const MAX_VALUE_CHARS = 24
const MAX_STRIP_W = 360
const MAX_ROOT_W = 220
const MEMORY_TTL = 12
const MEMORY_CAP = 400
const LOOP = 44

export type RootGroup = 'local' | 'capture' | 'global'

export interface HeapRoot {
  readonly key: string
  readonly name: string
  readonly group: RootGroup
  readonly value: ValueView
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface RootChip extends HeapRoot {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Value text for primitives, the object type for references. */
  readonly text: string
  /** Where edges start, for references. */
  readonly port: Point | null
  /** The referenced object, when it is drawn. */
  readonly target: number | null
}

export interface BoxRow {
  readonly key: string
  /** Index, key or capture name ('' for single-row boxes). */
  readonly label: string
  /** Display text; for references, the object preview (shown on hover). */
  readonly text: string
  readonly value: ValueView | null
  /** Relative to the box. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Absolute; set for references. */
  readonly port: Point | null
  /** The referenced object, when it is drawn. */
  readonly target: number | null
  /** True for the "+N more" row. */
  readonly more: boolean
}

export interface HeapBox {
  readonly id: number
  readonly type: ObjectView['type']
  readonly title: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly column: number
  /** List cells laid side by side. */
  readonly horizontal: boolean
  /** Width of the label column of vertical rows (0 when rows have no labels). */
  readonly labelWidth: number
  readonly rows: readonly BoxRow[]
}

export type EdgeSource =
  { readonly kind: 'root'; readonly key: string } | { readonly kind: 'box'; readonly id: number }

export interface HeapEdge {
  readonly key: string
  readonly from: EdgeSource
  readonly to: number
  readonly route: 'forward' | 'back' | 'self'
  /** SVG path data (one cubic curve). */
  readonly path: string
}

export interface MemoryEntry {
  readonly column: number
  readonly y: number
  /** Layouts since the box was last drawn. */
  readonly age: number
}

export interface LayoutMemory {
  readonly boxes: ReadonlyMap<number, MemoryEntry>
  readonly columnWidths: readonly number[]
}

export interface HeapLayout {
  readonly roots: readonly RootChip[]
  readonly groupLabels: readonly { readonly group: RootGroup; readonly y: number }[]
  readonly boxes: readonly HeapBox[]
  readonly edges: readonly HeapEdge[]
  /** Reachable objects not drawn because of the box cap. */
  readonly hiddenCount: number
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly memory: LayoutMemory
}

export interface HeapLayoutInput {
  readonly roots: readonly HeapRoot[]
  readonly heap: ReadonlyMap<number, ObjectView>
}

// ---------------------------------------------------------------------------------------------
// Roots

/** The selected frame's locals and captures, then the user globals (function declarations aside). */
export function collectRoots(
  frame: FrameView | null,
  globals: readonly GlobalView[],
): readonly HeapRoot[] {
  const locals: HeapRoot[] = (frame?.locals ?? []).map((local) => ({
    key: `local:${local.slot}:${local.name}`,
    name: local.name,
    group: 'local',
    value: local.value,
  }))
  const captures: HeapRoot[] = (frame?.captures ?? []).map((capture: CaptureView) => ({
    key: `capture:${capture.name}`,
    name: capture.name,
    group: 'capture',
    value: capture.value,
  }))
  const globalRoots: HeapRoot[] = globals
    .filter((global) => global.kind !== 'fn')
    .map((global) => ({
      key: `global:${global.name}`,
      name: global.name,
      group: 'global',
      value: global.value,
    }))
  return [...locals, ...captures, ...globalRoots]
}

// ---------------------------------------------------------------------------------------------
// Box contents (positions relative to the box; ports are filled in once the box is placed)

interface RawRow {
  readonly label: string
  readonly text: string
  readonly value: ValueView | null
  readonly more: boolean
}

interface Shape {
  readonly title: string
  readonly horizontal: boolean
  readonly rows: readonly RawRow[]
  readonly labelWidth: number
  readonly width: number
  readonly height: number
}

function textOf(value: ValueView): string {
  return truncate(formatValue(value), value.kind === 'ref' ? 48 : MAX_VALUE_CHARS)
}

function row(label: string, value: ValueView): RawRow {
  return { label: truncate(label, MAX_LABEL_CHARS), text: textOf(value), value, more: false }
}

function moreRow(hidden: number): RawRow {
  return { label: '', text: `+${hidden} more`, value: null, more: true }
}

function plain(text: string): RawRow {
  return { label: '', text, value: null, more: false }
}

function numberText(n: number): string {
  if (n === Infinity) return 'INF'
  if (n === -Infinity) return '-INF'
  return String(n)
}

function rangeText(start: number, end: number, step: number, inclusive: boolean): string {
  if (step !== 1) return `range(${numberText(start)}, ${numberText(end)}, ${numberText(step)})`
  return `${numberText(start)}${inclusive ? '..=' : '..'}${numberText(end)}`
}

function rawRows(object: ObjectView): { title: string; rows: RawRow[] } {
  switch (object.type) {
    case 'list': {
      const shown = object.items.slice(0, MAX_LIST_CELLS)
      const rows = shown.map((item, i) => row(String(object.offset + i), item))
      if (object.length > shown.length) rows.push(moreRow(object.length - shown.length))
      if (object.length === 0) rows.push(plain('empty'))
      return { title: `list [${object.length}]`, rows }
    }
    case 'record': {
      const shown = object.entries.slice(0, MAX_RECORD_ROWS)
      const rows = shown.map((entry) => row(entry.key, entry.value))
      if (object.length > shown.length) rows.push(moreRow(object.length - shown.length))
      if (object.length === 0) rows.push(plain('empty'))
      return { title: `record {${object.length}}`, rows }
    }
    case 'function': {
      const name = object.name ?? 'lambda'
      const captures = object.captures.map((capture) => row(capture.name, capture.value))
      return {
        title: object.library ? 'function · library' : 'function',
        rows: [plain(name), ...captures],
      }
    }
    case 'builtin':
      return { title: 'builtin', rows: [plain(object.name)] }
    case 'range':
      return {
        title: 'range',
        rows: [plain(rangeText(object.start, object.end, object.step, object.inclusive))],
      }
    case 'iterator':
      return {
        title: 'iterator',
        rows: [plain(`at ${object.position}`), row('source', object.source)],
      }
  }
}

function quantize(width: number): number {
  return Math.ceil(width / WIDTH_STEP) * WIDTH_STEP
}

function shownChars(item: RawRow): number {
  return item.value?.kind === 'ref' ? 2 : Math.min(item.text.length, MAX_VALUE_CHARS)
}

function shapeOf(object: ObjectView): Shape {
  const { title, rows } = rawRows(object)
  const titleW = title.length * CHAR_W + 2 * PAD_X
  const primitiveStrip =
    object.type === 'list' &&
    rows.every((r) => r.value?.kind !== 'ref' && !r.more) &&
    rows.length > 0
  const cellChars = Math.max(1, ...rows.map((r) => Math.max(shownChars(r), r.label.length)))
  const cellW = cellChars * CHAR_W + 2 * PAD_X
  if (primitiveStrip && rows[0]?.value && cellW * rows.length <= MAX_STRIP_W) {
    const width = quantize(Math.max(MIN_BOX_W, titleW, cellW * rows.length))
    return { title, horizontal: true, rows, labelWidth: 0, width, height: HEADER_H + ROW_H + 12 }
  }
  const labelChars = Math.min(MAX_LABEL_CHARS, Math.max(0, ...rows.map((r) => r.label.length)))
  const valueChars = Math.max(1, ...rows.map(shownChars))
  const contentW = (labelChars + valueChars) * CHAR_W + (labelChars > 0 ? 3 : 2) * PAD_X
  const width = quantize(Math.max(MIN_BOX_W, titleW, contentW))
  const labelWidth = labelChars > 0 ? labelChars * CHAR_W + 2 * PAD_X : 0
  return {
    title,
    horizontal: false,
    rows,
    labelWidth,
    width,
    height: HEADER_H + rows.length * ROW_H,
  }
}

function refId(value: ValueView | null): number | null {
  return value?.kind === 'ref' ? value.id : null
}

// ---------------------------------------------------------------------------------------------
// Reachability

interface Discovered {
  readonly order: readonly number[]
  readonly distance: ReadonlyMap<number, number>
  readonly shapes: ReadonlyMap<number, Shape>
}

/** Breadth-first over the drawn references (visible cells, rows and captures). */
function discover(roots: readonly HeapRoot[], heap: ReadonlyMap<number, ObjectView>): Discovered {
  const distance = new Map<number, number>()
  const shapes = new Map<number, Shape>()
  const order: number[] = []
  const queue: number[] = []
  const visit = (id: number | null, d: number) => {
    if (id === null || distance.has(id)) return
    const object = heap.get(id)
    if (!object) return
    distance.set(id, d)
    shapes.set(id, shapeOf(object))
    order.push(id)
    queue.push(id)
  }
  for (const root of roots) visit(refId(root.value), 1)
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!
    for (const r of shapes.get(id)!.rows) visit(refId(r.value), distance.get(id)! + 1)
  }
  return { order, distance, shapes }
}

// ---------------------------------------------------------------------------------------------
// Placement

interface Interval {
  start: number
  end: number
}

/** First y at or after `from` where `height` fits between the occupied intervals. */
function firstFit(occupied: readonly Interval[], height: number, from: number): number {
  let y = from
  for (const span of occupied) {
    if (y + height + BOX_GAP <= span.start) return y
    y = Math.max(y, span.end + BOX_GAP)
  }
  return y
}

function insertInterval(occupied: Interval[], span: Interval): void {
  const at = occupied.findIndex((other) => other.start > span.start)
  occupied.splice(at < 0 ? occupied.length : at, 0, span)
}

/** Remembered boxes keep their y (pushed down only to avoid overlap); new boxes take the first gap. */
function placeColumn(
  ids: readonly number[],
  heights: ReadonlyMap<number, number>,
  remembered: ReadonlyMap<number, MemoryEntry>,
): Map<number, number> {
  const ys = new Map<number, number>()
  const occupied: Interval[] = []
  const old = ids
    .filter((id) => remembered.has(id))
    .sort((a, b) => remembered.get(a)!.y - remembered.get(b)!.y || a - b)
  let bottom = -BOX_GAP
  for (const id of old) {
    const y = Math.max(remembered.get(id)!.y, bottom + BOX_GAP)
    ys.set(id, y)
    bottom = y + heights.get(id)!
    occupied.push({ start: y, end: bottom })
  }
  for (const id of ids.filter((id) => !remembered.has(id))) {
    const y = firstFit(occupied, heights.get(id)!, 0)
    ys.set(id, y)
    insertInterval(occupied, { start: y, end: y + heights.get(id)! })
  }
  return ys
}

function columnOf(id: number, distance: number, memory: LayoutMemory | null): number {
  return memory?.boxes.get(id)?.column ?? distance
}

// ---------------------------------------------------------------------------------------------
// Roots column

function rootChips(roots: readonly HeapRoot[], drawn: ReadonlySet<number>) {
  const texts = roots.map((root) =>
    root.value.kind === 'ref' ? root.value.type : textOf(root.value),
  )
  const chars = Math.max(4, ...roots.map((root, i) => root.name.length + texts[i]!.length + 2))
  const width = Math.min(MAX_ROOT_W, quantize(chars * CHAR_W + 2 * PAD_X + 8))
  const chips: RootChip[] = []
  const groupLabels: { group: RootGroup; y: number }[] = []
  let y = 0
  roots.forEach((root, i) => {
    if (i === 0 || roots[i - 1]!.group !== root.group) {
      if (i > 0) y += CHAR_W
      groupLabels.push({ group: root.group, y })
      y += GROUP_LABEL_H
    }
    const id = refId(root.value)
    chips.push({
      ...root,
      x: 0,
      y,
      width,
      height: CHIP_H,
      text: texts[i]!,
      port: id === null ? null : { x: width - PAD_X, y: y + CHIP_H / 2 },
      target: id !== null && drawn.has(id) ? id : null,
    })
    y += CHIP_H + CHIP_GAP
  })
  return { chips, groupLabels, width: roots.length > 0 ? width : 0, height: y }
}

// ---------------------------------------------------------------------------------------------
// Edges

function edgePath(from: Point, to: HeapBox, route: HeapEdge['route']): string {
  const f = (n: number) => Math.round(n * 10) / 10
  if (route === 'forward') {
    const tx = to.x
    const ty = to.y + HEADER_H / 2
    const dx = Math.max(24, (tx - from.x) / 2)
    return `M${f(from.x)},${f(from.y)} C${f(from.x + dx)},${f(from.y)} ${f(tx - dx)},${f(ty)} ${f(tx)},${f(ty)}`
  }
  if (route === 'self') {
    const tx = to.x + to.width
    const ty = to.y + HEADER_H / 2
    return `M${f(from.x)},${f(from.y)} C${f(tx + LOOP)},${f(from.y)} ${f(tx + LOOP)},${f(ty)} ${f(tx)},${f(ty)}`
  }
  const tx = to.x + to.width / 2
  const ty = to.y
  return `M${f(from.x)},${f(from.y)} C${f(from.x + LOOP * 1.5)},${f(from.y)} ${f(tx)},${f(ty - LOOP * 1.5)} ${f(tx)},${f(ty)}`
}

function buildEdges(chips: readonly RootChip[], boxes: readonly HeapBox[]): HeapEdge[] {
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const edges: HeapEdge[] = []
  for (const chip of chips) {
    if (chip.port === null || chip.target === null) continue
    const to = byId.get(chip.target)!
    edges.push({
      key: `r:${chip.key}`,
      from: { kind: 'root', key: chip.key },
      to: to.id,
      route: 'forward',
      path: edgePath(chip.port, to, 'forward'),
    })
  }
  for (const box of boxes) {
    for (const r of box.rows) {
      if (r.port === null || r.target === null) continue
      const to = byId.get(r.target)!
      const route = to.id === box.id ? 'self' : to.column > box.column ? 'forward' : 'back'
      edges.push({
        key: `b:${box.id}:${r.key}`,
        from: { kind: 'box', id: box.id },
        to: to.id,
        route,
        path: edgePath(r.port, to, route),
      })
    }
  }
  return edges
}

// ---------------------------------------------------------------------------------------------
// Layout

function positionedRows(
  shape: Shape,
  x: number,
  y: number,
  width: number,
  drawn: ReadonlySet<number>,
) {
  const cellW = shape.horizontal ? width / shape.rows.length : width
  return shape.rows.map((raw, i): BoxRow => {
    const rx = shape.horizontal ? i * cellW : 0
    const ry = HEADER_H + (shape.horizontal ? 0 : i * ROW_H)
    const height = shape.horizontal ? ROW_H + 12 : ROW_H
    const id = refId(raw.value)
    return {
      key: shape.horizontal || raw.label === '' ? String(i) : `${i}:${raw.label}`,
      label: raw.label,
      text: raw.text,
      value: raw.value,
      more: raw.more,
      x: rx,
      y: ry,
      width: cellW,
      height,
      port: id === null ? null : { x: x + width - PAD_X - 2, y: y + ry + ROW_H / 2 },
      target: id !== null && drawn.has(id) ? id : null,
    }
  })
}

function nextMemory(
  boxes: readonly HeapBox[],
  previous: LayoutMemory | null,
  columnWidths: readonly number[],
): LayoutMemory {
  const entries = new Map<number, MemoryEntry>()
  for (const box of boxes) entries.set(box.id, { column: box.column, y: box.y, age: 0 })
  const stale = [...(previous?.boxes ?? new Map<number, MemoryEntry>())]
    .filter(([id, entry]) => !entries.has(id) && entry.age + 1 <= MEMORY_TTL)
    .sort((a, b) => a[1].age - b[1].age || a[0] - b[0])
    .slice(0, Math.max(0, MEMORY_CAP - entries.size))
  for (const [id, entry] of stale) entries.set(id, { ...entry, age: entry.age + 1 })
  return { boxes: entries, columnWidths }
}

/** Lays out the heap graph; pass the previous layout's memory to keep boxes in place. */
export function layoutHeap(input: HeapLayoutInput, memory: LayoutMemory | null = null): HeapLayout {
  const found = discover(input.roots, input.heap)
  const shownIds = found.order.slice(0, MAX_BOXES)
  const drawn = new Set(shownIds)
  const roots = rootChips(input.roots, drawn)

  const columns = new Map<number, number[]>()
  for (const id of shownIds) {
    const column = columnOf(id, found.distance.get(id)!, memory)
    columns.set(column, [...(columns.get(column) ?? []), id])
  }
  const maxColumn = Math.max(0, ...columns.keys())
  const widths: number[] = [roots.width]
  for (let c = 1; c <= maxColumn; c++) {
    const ids = columns.get(c) ?? []
    const needed = Math.max(0, ...ids.map((id) => found.shapes.get(id)!.width))
    widths.push(ids.length > 0 ? Math.max(needed, memory?.columnWidths[c] ?? 0) : 0)
  }

  const heights = new Map(shownIds.map((id) => [id, found.shapes.get(id)!.height]))
  const remembered = memory?.boxes ?? new Map<number, MemoryEntry>()
  const boxes: HeapBox[] = []
  let x = roots.width > 0 ? roots.width + COL_GAP : 0
  for (let c = 1; c <= maxColumn; c++) {
    const ids = columns.get(c) ?? []
    const ys = placeColumn(ids, heights, remembered)
    for (const id of ids) {
      const shape = found.shapes.get(id)!
      const y = ys.get(id)!
      const width = shape.horizontal ? shape.width : widths[c]!
      const object = input.heap.get(id)!
      boxes.push({
        id,
        type: object.type,
        title: shape.title,
        x,
        y,
        width,
        height: shape.height,
        column: c,
        horizontal: shape.horizontal,
        labelWidth: shape.labelWidth,
        rows: positionedRows(shape, x, y, width, drawn),
      })
    }
    if (ids.length > 0) x += widths[c]! + COL_GAP
  }
  boxes.sort((a, b) => a.column - b.column || a.y - b.y)

  const edges = buildEdges(roots.chips, boxes)
  const right = Math.max(roots.width, ...boxes.map((box) => box.x + box.width + LOOP))
  const bottom = Math.max(roots.height, ...boxes.map((box) => box.y + box.height))
  const top = edges.some((edge) => edge.route === 'back') ? -LOOP * 1.5 : 0
  return {
    roots: roots.chips,
    groupLabels: roots.groupLabels,
    boxes,
    edges,
    hiddenCount: found.order.length - shownIds.length,
    bounds: {
      x: -MARGIN,
      y: top - MARGIN,
      width: right + 2 * MARGIN,
      height: bottom - top + 2 * MARGIN,
    },
    memory: nextMemory(boxes, memory, widths),
  }
}

/** Fitting never shrinks below this; larger graphs are panned instead of becoming unreadable. */
export const FIT_MIN_ZOOM = 0.85

/** The zoom that fits `bounds` into a viewport, kept between FIT_MIN_ZOOM and 1. */
export function fitZoom(
  viewport: { readonly width: number; readonly height: number },
  bounds: { readonly width: number; readonly height: number },
): number {
  const k = Math.min(1, viewport.width / bounds.width, viewport.height / bounds.height)
  return Number.isFinite(k) ? Math.max(FIT_MIN_ZOOM, k) : 1
}
