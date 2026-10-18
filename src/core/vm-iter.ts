/** `for` loop iteration (SPEC §8.3): `IterInit` and `IterNext`. */
import { InternalError } from './diagnostics'
import type { IteratorObj, Value } from './runtime-types'
import { articleType, isIterable, isRecord, rangeAccepts, rangeElement } from './values'
import { raise } from './vm-errors'
import type { MachineState } from './vm-state'

/** `IterInit`: `( it -- iter )`; records snapshot their keys now. */
export function iterInit(m: MachineState): void {
  const stack = m.stack
  const top = stack.length - 1
  const source = stack[top] as Value
  if (!isIterable(source)) raise('R013', `cannot iterate over ${articleType(source)}`)
  const keys = isRecord(source) ? Array.from(source.fields.keys()) : null
  stack[top] = m.newIterator(source, keys)
}

/**
 * `IterNext`: pushes the next element and returns true, or returns false when exhausted. Lists are
 * re-checked against their current length on every step.
 */
export function iterNext(m: MachineState): boolean {
  const stack = m.stack
  const iterator = stack[stack.length - 1] as IteratorObj
  const source = iterator.source
  const position = iterator.position
  let element: Value
  if (typeof source === 'string') {
    if (position >= source.length) return false
    element = source.charAt(position)
  } else if (iterator.keys !== null) {
    if (position >= iterator.keys.length) return false
    element = iterator.keys[position] as string
  } else if (typeof source === 'object' && source !== null && source.type === 'list') {
    if (position >= source.items.length) return false
    element = source.items[position] as Value
  } else if (typeof source === 'object' && source !== null && source.type === 'range') {
    element = rangeElement(source, position)
    if (!rangeAccepts(source, element)) return false
  } else {
    throw new InternalError('IterNext without an iterator')
  }
  iterator.position = position + 1
  stack.push(element)
  return true
}
