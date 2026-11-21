/**
 * Per-step marks drawn per pixel column (the strip chart's slice layer): an OR-mipmap of a 0/1
 * array, so "is any step of this column marked?" costs O(log N) and a million-step run draws in
 * milliseconds, like the depth envelope (timeline-math.ts).
 */
import type { Viewport } from './timeline-math'

/** Level k holds one byte per block of 2^k steps: 1 when any step of the block is marked. */
export interface MarkPyramid {
  readonly length: number
  /** Number of marked steps. */
  readonly count: number
  readonly levels: readonly Uint8Array[]
}

/** Builds the pyramid in O(N); the input is not copied or changed. */
export function buildMarkPyramid(marks: Uint8Array): MarkPyramid {
  const levels: Uint8Array[] = []
  let count = 0
  for (let i = 0; i < marks.length; i++) if (marks[i] !== 0) count += 1
  if (marks.length > 0) levels.push(marks)
  while (levels.length > 0 && levels[levels.length - 1]!.length > 1) {
    const previous = levels[levels.length - 1]!
    const next = new Uint8Array(Math.ceil(previous.length / 2))
    for (let i = 0; i < next.length; i++) {
      const a = previous[2 * i]!
      const b = 2 * i + 1 < previous.length ? previous[2 * i + 1]! : 0
      next[i] = a !== 0 || b !== 0 ? 1 : 0
    }
    levels.push(next)
  }
  return { length: marks.length, count, levels }
}

/** True when any step in `[from, to)` is marked (bounds clipped to the marks). */
export function anyMarked(pyramid: MarkPyramid, from: number, to: number): boolean {
  let lo = Math.max(0, Math.floor(from))
  let hi = Math.min(pyramid.length, Math.ceil(to))
  for (let level = 0; lo < hi; level++) {
    const marks = pyramid.levels[level]!
    if (lo & 1) {
      if (marks[lo] !== 0) return true
      lo++
    }
    if (hi & 1) {
      hi--
      if (marks[hi] !== 0) return true
    }
    lo >>= 1
    hi >>= 1
  }
  return false
}

/**
 * Per pixel column of the view, 1 when a step it covers is marked. Columns cover steps exactly as
 * the depth envelope's do: step `t` occupies `[t, t + 1)`, and a column covers at least one step.
 */
export function markedColumns(pyramid: MarkPyramid, view: Viewport, columns: number): Uint8Array {
  const count = Math.max(0, Math.floor(columns))
  const out = new Uint8Array(count)
  const span = view.end - view.start
  if (count === 0 || !(span > 0) || pyramid.count === 0) return out
  for (let c = 0; c < count; c++) {
    const from = Math.floor(view.start + (c * span) / count)
    const to = Math.max(from + 1, Math.ceil(view.start + ((c + 1) * span) / count))
    if (anyMarked(pyramid, from, to)) out[c] = 1
  }
  return out
}
