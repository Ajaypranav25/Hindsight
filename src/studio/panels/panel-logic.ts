/** Pure helpers for the inspector panels (unit-tested in node). */
import type {
  LocalView,
  ObjectView,
  OutputEvent,
  ProvenanceEvent,
  StateView,
  TracedValue,
  ValueView,
  WriteTarget,
} from '../../core/index'
import { formatValue, reprString, sameValue, truncate } from '../lib/format'

/** Pen moves longer than this many steps do not flash changed values. */
export const MAX_FLASH_JUMP = 500
/** Items fetched per page of a long list or record. */
export const PAGE_SIZE = 100
/** Output lines rendered around the pen. */
export const CONSOLE_WINDOW = 500
/** Events requested for a history list. */
export const HISTORY_LIMIT = 500

const EMPTY: ReadonlySet<string> = new Set()

/** A stable string identity for a write target. */
export function targetKey(target: WriteTarget): string {
  switch (target.kind) {
    case 'local':
      return `local:${target.frameUid}:${target.slot}`
    case 'global':
      return `global:${target.name}`
    case 'field':
      return `field:${target.objectId}:${target.key}`
    case 'element':
      return `element:${target.objectId}:${target.index}`
    case 'object':
      return `object:${target.objectId}`
    case 'cell':
      return `cell:${target.cellId}`
  }
}

/** True when both targets name the same place. */
export function sameTarget(a: WriteTarget | null | undefined, b: WriteTarget): boolean {
  return a != null && targetKey(a) === targetKey(b)
}

interface Binding {
  readonly target: WriteTarget
  readonly value: ValueView
}

function bindings(view: StateView): Map<string, ValueView> {
  const all: Binding[] = [...view.globals]
  for (const frame of view.frames) all.push(...frame.locals, ...frame.captures)
  return new Map(all.map((b) => [targetKey(b.target), b.value]))
}

/**
 * Keys (see `targetKey`) of the bindings whose value differs between two pen positions. A binding
 * that appears counts as changed when its scope already existed (a global, or a local in a frame
 * that was live before). Jumps longer than `maxJump` steps report nothing.
 */
export function changedTargets(
  prev: StateView | null,
  next: StateView,
  maxJump = MAX_FLASH_JUMP,
): ReadonlySet<string> {
  if (!prev || prev === next || Math.abs(next.time - prev.time) > maxJump) return EMPTY
  const before = bindings(prev)
  const liveFrames = new Set(prev.frames.map((frame) => frame.uid))
  const changed = new Set<string>()
  for (const [key, value] of bindings(next)) {
    const old = before.get(key)
    if (old ? !sameValue(old, value) : appearedInScope(key, liveFrames)) changed.add(key)
  }
  return changed.size === 0 ? EMPTY : changed
}

function appearedInScope(key: string, liveFrames: ReadonlySet<number>): boolean {
  if (key.startsWith('global:')) return true
  if (!key.startsWith('local:')) return false
  return liveFrames.has(Number(key.split(':')[1]))
}

/** "n = 3, acc = [1, 2]" for the first `count` locals of a frame. */
export function localsSummary(locals: readonly LocalView[], count = 2, width = 18): string {
  const shown = locals
    .slice(0, count)
    .map((l) => `${l.name} = ${truncate(formatValue(l.value), width)}`)
  return locals.length > count ? `${shown.join(', ')}, …` : shown.join(', ')
}

/** Number of events with `time < t` (outputs are sorted by time). */
export function countBefore(events: readonly { readonly time: number }[], t: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid]!.time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface ConsoleWindow {
  readonly start: number
  readonly end: number
  /** Number of lines printed before the pen. */
  readonly printed: number
}

/** The slice of output lines to render: about `size` lines centred on the pen. */
export function consoleWindow(
  outputs: readonly OutputEvent[],
  time: number,
  size = CONSOLE_WINDOW,
): ConsoleWindow {
  const printed = countBefore(outputs, time)
  const half = Math.floor(size / 2)
  const start = Math.max(0, Math.min(printed - half, outputs.length - size))
  return { start, end: Math.min(outputs.length, start + size), printed }
}

/** One-line text for a traced value stored with a provenance event. */
export function formatTraced(value: TracedValue): string {
  if (value === null) return 'nil'
  if (typeof value === 'string') return reprString(value)
  if (typeof value === 'object') return `object #${value.ref}`
  return String(value)
}

const LIST_OPS: Readonly<Record<string, string>> = {
  append: 'append',
  extend: 'extend',
  insert: 'insert',
  remove: 'remove',
  pop: 'pop',
}

/** What an event did, in a word or two: "declare", "set", "insert at 2". */
export function eventLabel(event: ProvenanceEvent): string {
  switch (event.kind) {
    case 'declare':
      return 'declare'
    case 'write':
      return 'set'
    case 'alloc':
      return 'create'
    case 'delete':
      return 'delete'
    case 'list': {
      const op = LIST_OPS[event.op ?? 'append'] ?? 'change'
      return event.index === undefined ? op : `${op} at ${event.index}`
    }
  }
}

/** Index of the event whose effect is current at the pen (the last with `time < t`), or -1. */
export function currentEventIndex(events: readonly ProvenanceEvent[], t: number): number {
  return countBefore(events, t) - 1
}

/** The numeric values of a history, or null when any value is not a number. */
export function numericValues(events: readonly ProvenanceEvent[]): number[] | null {
  const values: number[] = []
  for (const event of events) {
    if (typeof event.value !== 'number' || !Number.isFinite(event.value)) return null
    values.push(event.value)
  }
  return values.length >= 2 ? values : null
}

export interface Sparkline {
  /** Polyline points. */
  readonly line: string
  /** Closed polygon for the area under the line (down to the baseline). */
  readonly area: string
  /** y of the zero line when it is in range, else of the bottom edge. */
  readonly baseline: number
  /** x position of each value. */
  readonly xs: readonly number[]
}

/** Geometry for a sparkline of `values` over their index, in a `width` × `height` box. */
export function sparkline(
  values: readonly number[],
  width: number,
  height: number,
  pad = 2,
): Sparkline {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const xOf = (i: number) => (values.length < 2 ? width / 2 : (i / (values.length - 1)) * width)
  const yOf = (v: number) => pad + (1 - (v - min) / span) * (height - 2 * pad)
  const xs = values.map((_, i) => round(xOf(i)))
  const points = values.map((v, i) => `${xs[i]},${round(yOf(v))}`)
  const baseline = round(min <= 0 && max >= 0 ? yOf(0) : height - pad)
  const area = [`${xs[0]},${baseline}`, ...points, `${xs[xs.length - 1]},${baseline}`].join(' ')
  return { line: points.join(' '), area, baseline, xs }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** "0..10", "1..=9 by 2". */
export function formatRange(range: Extract<ObjectView, { type: 'range' }>): string {
  const op = range.inclusive ? '..=' : '..'
  const step = range.step === 1 ? '' : ` by ${range.step}`
  return `${range.start}${op}${range.end}${step}`
}
