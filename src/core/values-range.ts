/**
 * Range arithmetic (SPEC §7.6). Re-exported by values.ts.
 *
 * Element k is exactly `start + k * step`. For a finite, non-zero step the elements are monotone in
 * k (rounding is monotone), so the accepted elements form a prefix and both the length and
 * membership can be found by bisection instead of iteration.
 */
import type { RangeObj, Value } from './runtime-types'

export function rangeElement(range: RangeObj, k: number): number {
  return range.start + k * range.step
}

/** The bound test of SPEC §7.6. False for NaN elements and for a NaN step. */
export function rangeAccepts(range: RangeObj, element: number): boolean {
  if (range.step > 0) return range.inclusive ? element <= range.end : element < range.end
  if (range.step < 0) return range.inclusive ? element >= range.end : element > range.end
  return false
}

/** The number of elements: `Infinity` for an unbounded range. Never iterates. */
export function rangeLength(range: RangeObj): number {
  if (!rangeAccepts(range, rangeElement(range, 0))) return 0
  if (isUnbounded(range)) return Infinity
  return firstRejected(range)
}

/** True when `value` is a number `===` to some element. Terminates for unbounded ranges. */
export function rangeContains(range: RangeObj, value: Value): boolean {
  if (typeof value !== 'number' || Number.isNaN(value)) return false
  const length = rangeLength(range)
  if (length === 0) return false
  const reaches = (k: number): boolean => {
    const element = rangeElement(range, k)
    return range.step > 0 ? element >= value : element <= value
  }
  if (reaches(0)) return rangeElement(range, 0) === value
  const high = length === Infinity ? searchUpward(range, value, reaches) : length
  if (high === Infinity || !reaches(high)) return false
  const k = firstTrue(reaches, 0, high)
  return k < length && rangeElement(range, k) === value
}

/** Element 0 is accepted here, so start, end and step are not NaN and step is finite. */
function isUnbounded(range: RangeObj): boolean {
  return range.step > 0
    ? range.end === Infinity || range.start === -Infinity
    : range.end === -Infinity || range.start === Infinity
}

/** The first rejected k of a bounded range whose element 0 is accepted. */
function firstRejected(range: RangeObj): number {
  const rejects = (k: number): boolean => !rangeAccepts(range, rangeElement(range, k))
  let accepted = 0
  let candidate = Math.max(1, Math.ceil((range.end - range.start) / range.step))
  while (!rejects(candidate)) {
    accepted = candidate
    candidate *= 2
    if (candidate === Infinity) return Infinity
  }
  return firstTrue(rejects, accepted, candidate)
}

/** Some k with `reaches(k)` for an unbounded range, or Infinity when there is none. */
function searchUpward(range: RangeObj, value: number, reaches: (k: number) => boolean): number {
  let k = Math.max(1, Math.ceil((value - range.start) / range.step))
  while (!reaches(k)) {
    k *= 2
    if (k === Infinity) return Infinity
  }
  return k
}

/**
 * For a predicate that is false up to some k and true from then on, with `predicate(low)` false
 * and `predicate(high)` true, the first true k in `(low, high]`. Above 2^53 the integers run out
 * of precision; the search then stops within one double of the exact answer.
 */
function firstTrue(predicate: (k: number) => boolean, low: number, high: number): number {
  while (high - low > 1) {
    const mid = Math.floor(low + (high - low) / 2)
    if (mid <= low || mid >= high) break
    if (predicate(mid)) high = mid
    else low = mid
  }
  return high
}
