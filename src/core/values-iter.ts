/**
 * Iteration helpers (SPEC §8.3): what `for`, spreads and `list()` accept and yield.
 * Re-exported by values.ts.
 */
import { InternalError } from './diagnostics'
import type { ListObj, RangeObj, RecordObj, Value } from './runtime-types'
import { SIZE_LIMIT } from './values-guards'
import { rangeElement, rangeLength } from './values-range'

export type IterableValue = ListObj | RangeObj | RecordObj | string

export function isIterable(value: Value): value is IterableValue {
  if (typeof value === 'string') return true
  return (
    typeof value === 'object' &&
    value !== null &&
    (value.type === 'list' || value.type === 'range' || value.type === 'record')
  )
}

/** How many elements iteration yields right now; `Infinity` for unbounded ranges. */
export function elementCount(value: IterableValue): number {
  if (typeof value === 'string') return value.length
  switch (value.type) {
    case 'list':
      return value.items.length
    case 'record':
      return value.fields.size
    case 'range':
      return rangeLength(value)
  }
}

/**
 * A fresh array of the elements: list items, range elements, one-code-unit strings, or record keys
 * in insertion order. Callers check `elementCount` against SIZE_LIMIT first.
 */
export function collectElements(value: IterableValue): Value[] {
  if (typeof value === 'string') return value.split('')
  switch (value.type) {
    case 'list':
      return value.items.slice()
    case 'record':
      return Array.from(value.fields.keys())
    case 'range':
      return rangeElements(value)
  }
}

function rangeElements(range: RangeObj): number[] {
  const count = rangeLength(range)
  if (count > SIZE_LIMIT) throw new InternalError('range is too large to collect')
  const elements = new Array<number>(count)
  for (let k = 0; k < count; k++) elements[k] = rangeElement(range, k)
  return elements
}
