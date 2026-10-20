/** Field access (SPEC §7.9) and indexing (SPEC §7.7), for reads and writes. */
import { didYouMean } from './diagnostics'
import type { RecordObj, Value } from './runtime-types'
import { SIZE_LIMIT, articleType, isList, isRecord } from './values'
import { normalizeIndex, type SequenceKind } from './values-index'
import { raise, raiseTooLarge } from './vm-errors'
import type { MachineState } from './vm-state'

/** SPEC §7.9: the R010 hint considers only this many keys, in insertion order. */
export const HINT_KEY_LIMIT = 10_000

function* firstKeys(record: RecordObj): Generator<string> {
  let count = 0
  for (const key of record.fields.keys()) {
    if (count++ >= HINT_KEY_LIMIT) return
    yield key
  }
}

function missingField(record: RecordObj, key: string): never {
  return raise('R010', `record has no field '${key}'`, didYouMean(key, firstKeys(record)))
}

/** SPEC §10.5: a new key must fit the size limit and is charged against the allocation budget. */
function checkNewKey(m: MachineState, record: RecordObj, key: string): void {
  if (record.fields.has(key)) return
  if (record.fields.size >= SIZE_LIMIT) raiseTooLarge()
  m.charge(1)
}

export function getField(object: Value, name: string): Value {
  if (!isRecord(object)) raise('R011', `cannot read field '${name}' of ${articleType(object)}`)
  const value = object.fields.get(name)
  return value === undefined ? missingField(object, name) : value
}

export function setField(m: MachineState, object: Value, name: string, value: Value): void {
  if (!isRecord(object)) raise('R011', `cannot set field '${name}' on ${articleType(object)}`)
  checkNewKey(m, object, name)
  object.fields.set(name, value)
  m.recordField(object.id, name, value)
}

function checkedIndex(index: Value, length: number, kind: SequenceKind): number {
  const result = normalizeIndex(index, length, kind)
  return typeof result === 'number' ? result : raise(result.code, result.message)
}

function recordKey(index: Value): string {
  if (typeof index !== 'string')
    raise('R012', `record keys must be strings, got ${articleType(index)}`)
  return index
}

export function getIndex(object: Value, index: Value): Value {
  if (isList(object)) {
    const items = object.items
    // Fast path: an in-range non-negative integer (lists never exceed 2^24 items).
    if (typeof index === 'number' && (index | 0) === index && index >= 0 && index < items.length) {
      return items[index] as Value
    }
    return items[checkedIndex(index, items.length, 'list')] as Value
  }
  if (typeof object === 'string') return object.charAt(checkedIndex(index, object.length, 'string'))
  if (isRecord(object)) {
    const key = recordKey(index)
    const value = object.fields.get(key)
    return value === undefined ? missingField(object, key) : value
  }
  return raise('R009', `cannot index ${articleType(object)}`)
}

export function setIndex(m: MachineState, object: Value, index: Value, value: Value): void {
  if (typeof object === 'string')
    raise('R022', 'cannot assign into a string: strings are immutable')
  if (isList(object)) {
    const position = checkedIndex(index, object.items.length, 'list')
    object.items[position] = value
    m.recordElement(object.id, position, value)
    return
  }
  if (isRecord(object)) {
    const key = recordKey(index)
    checkNewKey(m, object, key)
    object.fields.set(key, value)
    m.recordField(object.id, key, value)
    return
  }
  raise('R009', `cannot index ${articleType(object)}`)
}
