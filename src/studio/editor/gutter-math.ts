/** Pure helpers for the heat gutter. */
import { formatCount } from '../lib/format'

/** The shortest bar drawn for a line that ran at least once. */
export const MIN_HEAT = 0.12

/** Bar length in [0, 1] on a log scale: one hit stays visible, the hottest line is full. */
export function heatLevel(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0
  if (count >= maxCount) return 1
  const level = Math.log1p(count) / Math.log1p(maxCount)
  return Math.max(MIN_HEAT, Math.min(1, level))
}

export function maxHitCount(counts: ReadonlyMap<number, number>): number {
  let max = 0
  for (const count of counts.values()) if (count > max) max = count
  return max
}

/** Tooltip text: "ran 1,204 times · click to jump to the next run". */
export function heatTitle(count: number): string {
  const times = count === 1 ? 'once' : `${formatCount(count)} times`
  return `ran ${times} · click to jump to the next run`
}

/** The first hit after `time`, wrapping around to the first hit; null when there are none. */
export function nextHit(hits: readonly number[], time: number): number | null {
  if (hits.length === 0) return null
  let lo = 0
  let hi = hits.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (hits[mid]! > time) hi = mid
    else lo = mid + 1
  }
  return hits[lo] ?? hits[0]!
}
