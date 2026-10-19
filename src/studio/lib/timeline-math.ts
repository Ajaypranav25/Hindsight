/**
 * Pure math for the strip chart: depth envelopes (min/max mipmaps), viewport zoom and pan,
 * time <-> x conversion, nice step ticks, marker thinning and readout text.
 */
import type { Location } from '../../core/api-types'
import { formatCount, formatSteps } from './format'

// ---------------------------------------------------------------------------------------------
// Depth envelope

/** Min/max mipmap of a depth series: level k summarizes blocks of 2^k steps. */
export interface DepthEnvelope {
  /** Number of steps summarized (N). */
  readonly length: number
  readonly maxDepth: number
  readonly mins: readonly Int32Array[]
  readonly maxs: readonly Int32Array[]
}

/** Per-column envelope; columns without steps hold NO_DATA in both arrays. */
export interface ColumnEnvelope {
  readonly min: Int32Array
  readonly max: Int32Array
}

export const NO_DATA = -1

/** Builds the mipmap once per recording in O(N). The input is not copied or changed. */
export function buildEnvelope(depths: Int32Array): DepthEnvelope {
  const mins: Int32Array[] = []
  const maxs: Int32Array[] = []
  let maxDepth = 0
  for (let i = 0; i < depths.length; i++) if (depths[i]! > maxDepth) maxDepth = depths[i]!
  if (depths.length > 0) {
    mins.push(depths)
    maxs.push(depths)
  }
  while (mins.length > 0 && mins[mins.length - 1]!.length > 1) {
    const prevMin = mins[mins.length - 1]!
    const prevMax = maxs[maxs.length - 1]!
    const size = Math.ceil(prevMin.length / 2)
    const min = new Int32Array(size)
    const max = new Int32Array(size)
    for (let i = 0; i < size; i++) {
      const a = 2 * i
      const b = a + 1 < prevMin.length ? a + 1 : a
      min[i] = Math.min(prevMin[a]!, prevMin[b]!)
      max[i] = Math.max(prevMax[a]!, prevMax[b]!)
    }
    mins.push(min)
    maxs.push(max)
  }
  return { length: depths.length, maxDepth, mins, maxs }
}

/**
 * Min and max depth over the steps `[from, to)` in O(log N); null when the range is empty.
 * Out-of-range bounds are clipped to the series.
 */
export function rangeMinMax(
  env: DepthEnvelope,
  from: number,
  to: number,
): { min: number; max: number } | null {
  let lo = Math.max(0, Math.floor(from))
  let hi = Math.min(env.length, Math.ceil(to))
  if (lo >= hi) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let level = 0; lo < hi; level++) {
    const mins = env.mins[level]!
    const maxs = env.maxs[level]!
    if (lo & 1) {
      if (mins[lo]! < min) min = mins[lo]!
      if (maxs[lo]! > max) max = maxs[lo]!
      lo++
    }
    if (hi & 1) {
      hi--
      if (mins[hi]! < min) min = mins[hi]!
      if (maxs[hi]! > max) max = maxs[hi]!
    }
    lo >>= 1
    hi >>= 1
  }
  return { min, max }
}

/**
 * Min/max depth per pixel column for the time range `[viewStart, viewEnd)`. Step `t` occupies
 * `[t, t + 1)`; a column covers every step its time range touches (at least one).
 */
export function envelope(
  env: DepthEnvelope,
  viewStart: number,
  viewEnd: number,
  columns: number,
): ColumnEnvelope {
  const count = Math.max(0, Math.floor(columns))
  const min = new Int32Array(count).fill(NO_DATA)
  const max = new Int32Array(count).fill(NO_DATA)
  const span = viewEnd - viewStart
  if (count === 0 || !(span > 0)) return { min, max }
  for (let c = 0; c < count; c++) {
    const from = Math.floor(viewStart + (c * span) / count)
    const to = Math.max(from + 1, Math.ceil(viewStart + ((c + 1) * span) / count))
    const range = rangeMinMax(env, from, to)
    if (range) {
      min[c] = range.min
      max[c] = range.max
    }
  }
  return { min, max }
}

// ---------------------------------------------------------------------------------------------
// Viewport

/** The visible time range `[start, end]` (real numbers). */
export interface Viewport {
  readonly start: number
  readonly end: number
}

export const MIN_VISIBLE_STEPS = 50

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/** The whole run: `[0, N]` (at least one step wide so the scale is never degenerate). */
export function fullViewport(length: number): Viewport {
  return { start: 0, end: Math.max(1, length) }
}

/** Keeps the span within [min(50, N), N] and the range within [0, N]. */
export function clampViewport(view: Viewport, length: number): Viewport {
  const total = Math.max(1, length)
  const minSpan = Math.min(MIN_VISIBLE_STEPS, total)
  const rawSpan = view.end - view.start
  const span = Number.isFinite(rawSpan) ? clamp(rawSpan, minSpan, total) : total
  const start = Number.isFinite(view.start) ? clamp(view.start, 0, total - span) : 0
  return { start, end: start + span }
}

/** True when the view shows less than the whole run. */
export function isZoomed(view: Viewport, length: number): boolean {
  const full = fullViewport(length)
  return view.start > full.start || view.end < full.end
}

/** Scales the span by `factor` (< 1 zooms in) keeping `anchor` at the same screen position. */
export function zoomAround(
  view: Viewport,
  anchor: number,
  factor: number,
  length: number,
): Viewport {
  const total = Math.max(1, length)
  const span = view.end - view.start
  const newSpan = clamp(span * factor, Math.min(MIN_VISIBLE_STEPS, total), total)
  const ratio = span > 0 ? clamp((anchor - view.start) / span, 0, 1) : 0
  const start = anchor - ratio * newSpan
  return clampViewport({ start, end: start + newSpan }, length)
}

/** Moves the view by `delta` steps, stopping at either end of the run. */
export function panBy(view: Viewport, delta: number, length: number): Viewport {
  return clampViewport({ start: view.start + delta, end: view.end + delta }, length)
}

/** Keeps the view when `time` is visible, otherwise centers it on `time` with the same span. */
export function followTime(view: Viewport, time: number, length: number): Viewport {
  if (time >= view.start && time <= view.end) return view
  const span = view.end - view.start
  return clampViewport({ start: time - span / 2, end: time + span / 2 }, length)
}

export function timeToX(time: number, view: Viewport, width: number): number {
  return ((time - view.start) / (view.end - view.start)) * width
}

export function xToTime(x: number, view: Viewport, width: number): number {
  return view.start + (x / Math.max(1, width)) * (view.end - view.start)
}

/** The integer step under `x`, clamped to `[0, N]` (what a click seeks to). */
export function stepAtX(x: number, view: Viewport, width: number, length: number): number {
  return clamp(Math.round(xToTime(x, view, width)), 0, Math.max(0, length))
}

// ---------------------------------------------------------------------------------------------
// Ticks and grid

/** The smallest 1, 2 or 5 × 10^k that is at least `raw` (and at least 1). */
export function niceStep(raw: number): number {
  if (!(raw > 1)) return 1
  const power = 10 ** Math.floor(Math.log10(raw))
  for (const lead of [1, 2, 5, 10]) {
    if (lead * power >= raw - 1e-9 * power) return lead * power
  }
  return 10 * power
}

/** Minor grid spacing inside one major division (5 or 4 parts, never below one step). */
export function minorStepFor(major: number): number {
  const lead = Math.round(major / 10 ** Math.floor(Math.log10(major)))
  const minor = major / (lead === 2 ? 4 : 5)
  if (minor >= 1) return minor
  return major >= 2 ? 1 : major
}

export interface Tick {
  readonly time: number
  readonly x: number
  readonly label: string
}

export interface Axis {
  /** Steps per major division. */
  readonly major: number
  readonly minor: number
  readonly ticks: readonly Tick[]
}

/** Major ticks at least `minSpacing` px apart, labeled with compact step counts. */
export function axisTicks(view: Viewport, width: number, minSpacing = 72): Axis {
  const span = view.end - view.start
  const major = niceStep((span * minSpacing) / Math.max(1, width))
  const ticks = multiplesIn(view.start, view.end, major).map((time) => ({
    time,
    x: timeToX(time, view, width),
    label: formatSteps(time),
  }))
  return { major, minor: minorStepFor(major), ticks }
}

/** Multiples of `step` in `[start, end]`, at most `limit` of them. */
export function multiplesIn(start: number, end: number, step: number, limit = 4000): number[] {
  const out: number[] = []
  for (let k = Math.ceil(start / step); k * step <= end && out.length < limit; k++) {
    out.push(k * step)
  }
  return out
}

/** "1 div = 5k steps". */
export function chartSpeedText(major: number): string {
  return `1 div = ${formatSteps(major)} ${major === 1 ? 'step' : 'steps'}`
}

// ---------------------------------------------------------------------------------------------
// Markers

/** First index `i >= lo` with `sorted[i] >= value` (sorted ascending). */
export function lowerBound(sorted: ArrayLike<number>, value: number, lo = 0): number {
  let a = lo
  let b = sorted.length
  while (a < b) {
    const mid = (a + b) >>> 1
    if (sorted[mid]! < value) a = mid + 1
    else b = mid
  }
  return a
}

/**
 * Distinct pixel columns (floor of x) of the sorted times inside the view. Skips ahead by binary
 * search, so a million events cost O(columns · log n).
 */
export function markerColumns(sorted: ArrayLike<number>, view: Viewport, width: number): number[] {
  const out: number[] = []
  let i = lowerBound(sorted, view.start)
  while (i < sorted.length && sorted[i]! <= view.end) {
    const x = Math.floor(timeToX(sorted[i]!, view, width))
    if (out.length === 0 || out[out.length - 1] !== x) out.push(x)
    i = Math.max(i + 1, lowerBound(sorted, xToTime(x + 1, view, width), i + 1))
  }
  return out
}

/** Sorted union of several time lists. */
export function mergeTimes(lists: readonly (readonly number[])[]): Float64Array {
  const merged = Float64Array.from(lists.flat())
  return merged.sort()
}

// ---------------------------------------------------------------------------------------------
// Depth scale, progress and text

export interface DepthScale {
  readonly baseline: number
  readonly unit: number
}

/** Depth 0 sits one unit above the baseline; the deepest call reaches near `top`. */
export function depthScale(maxDepth: number, top: number, baseline: number, maxUnit: number) {
  const unit = Math.max(0.5, Math.min(maxUnit, (baseline - top) / (Math.max(0, maxDepth) + 1)))
  return { baseline, unit } satisfies DepthScale
}

export function depthToY(depth: number, scale: DepthScale): number {
  return scale.baseline - (depth + 1) * scale.unit
}

/** Moves `current` toward `target` exponentially (time constant `tau` ms); snaps when close. */
export function approach(current: number, target: number, dtMs: number, tau: number): number {
  const next = target + (current - target) * Math.exp(-Math.max(0, dtMs) / tau)
  return Math.abs(next - target) < 1e-3 ? target : next
}

/** Fraction of the step budget recorded so far, in [0, 1]. */
export function recordingFraction(progress: number, budget: number): number {
  return budget > 0 ? clamp(progress / budget, 0, 1) : 0
}

/** "line 7 · fib" for user code, "map (library)" for prelude code. */
export function locationText(location: Location | null): string {
  if (!location) return 'end of run'
  if (location.source === 'prelude') return `${location.functionName} (library)`
  return `line ${location.line} · ${location.functionName}`
}

/** The slider's aria-valuetext: "step 1,234 of 56,789, line 7". */
export function stepValueText(time: number, length: number, location: Location | null): string {
  const base = `step ${formatCount(time)} of ${formatCount(length)}`
  return location && location.source === 'main' ? `${base}, line ${location.line}` : base
}

/** Digits needed for the tape counter: at least 7, more for longer runs. */
export function tapeWidth(length: number): number {
  return Math.max(7, String(Math.max(0, Math.trunc(length))).length)
}
