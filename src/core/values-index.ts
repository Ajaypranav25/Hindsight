/**
 * Index normalization shared by indexing (SPEC §7.7) and the index arguments of natives
 * (SPEC §9.1 rule 4). Returns the normalized index or the error to raise, so the VM and natives can
 * each raise it their own way.
 */
import type { Value } from './runtime-types'
import { SIZE_LIMIT } from './values-guards'
import { formatNumber, preview } from './values-show'

export type SequenceKind = 'list' | 'string'

export interface IndexError {
  readonly code: 'R007' | 'R008'
  readonly message: string
}

/**
 * `index` must be an integer; negative values count from the end. Valid results are
 * `0 .. length - 1`, or `0 ..= length` when `allowEnd` (insertion positions).
 */
export function normalizeIndex(
  index: Value,
  length: number,
  kind: SequenceKind,
  allowEnd = false,
): number | IndexError {
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    return { code: 'R008', message: `${kind} index must be an integer, got ${messageRepr(index)}` }
  }
  const normalized = index < 0 ? index + length : index
  const limit = allowEnd ? length + 1 : length
  if (normalized < 0 || normalized >= limit) {
    const message = `index ${formatNumber(index)} is out of bounds for a ${kind} of length ${length}`
    return { code: 'R007', message }
  }
  return normalized
}

/**
 * `repr` for use inside an error message. Bounded so that an absurdly large value cannot exceed the
 * engine's string limits; below SIZE_LIMIT it is the exact repr.
 */
export function messageRepr(value: Value): string {
  return preview(value, SIZE_LIMIT)
}
