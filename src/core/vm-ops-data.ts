/**
 * List and record literals, spreads (SPEC §7.8, §7.9) and string interpolation. Each operates on
 * the top of the stack as described by its opcode's stack effect (ARCHITECTURE §5.2).
 */
import { InternalError } from './diagnostics'
import type { ListObj, RecordObj, Value } from './runtime-types'
import {
  SIZE_LIMIT,
  articleType,
  collectElements,
  elementCount,
  isIterable,
  isList,
  isRecord,
  showWithin,
} from './values'
import { raise, raiseTooLarge } from './vm-errors'
import type { MachineState } from './vm-state'

function listUnder(stack: Value[]): ListObj {
  const list = stack[stack.length - 1] as Value
  if (!isList(list)) throw new InternalError('expected a list under the operand')
  return list
}

function recordUnder(stack: Value[]): RecordObj {
  const record = stack[stack.length - 1] as Value
  if (!isRecord(record)) throw new InternalError('expected a record under the operand')
  return record
}

/** `List n`: `( v1…vn -- list )`. */
export function listLiteral(m: MachineState, count: number): void {
  const stack = m.stack
  const start = stack.length - count
  const items = stack.slice(start)
  stack.length = start
  stack.push(m.newList(items))
}

/** `ListAppend`: `( list v -- list )`. */
export function listAppend(m: MachineState): void {
  const value = m.stack.pop() as Value
  const list = listUnder(m.stack)
  if (list.items.length >= SIZE_LIMIT) raiseTooLarge()
  m.appendItem(list, value)
}

/** `ListExtend`: `( list it -- list )`, appending every element of an iterable. */
export function listExtend(m: MachineState): void {
  const iterable = m.stack.pop() as Value
  const list = listUnder(m.stack)
  if (!isIterable(iterable)) raise('R013', `cannot iterate over ${articleType(iterable)}`)
  const count = elementCount(iterable)
  if (list.items.length + count > SIZE_LIMIT) raiseTooLarge()
  const first = list.items.length
  const items = list.items
  for (const element of collectElements(iterable)) items.push(element)
  if (count > 0) m.recordListOp(list.id, 'extend', first, count, iterable)
}

/** `Record n`: `( k1 v1 … kn vn -- rec )`; a repeated key keeps its first position. */
export function recordLiteral(m: MachineState, count: number): void {
  const stack = m.stack
  const start = stack.length - 2 * count
  const fields = new Map<string, Value>()
  for (let i = start; i < stack.length; i += 2) fields.set(stack[i] as string, stack[i + 1] as Value)
  stack.length = start
  stack.push(m.newRecord(fields))
}

/** `RecordSet`: `( rec k v -- rec )`. */
export function recordSet(m: MachineState): void {
  const value = m.stack.pop() as Value
  const key = m.stack.pop() as string
  const record = recordUnder(m.stack)
  if (record.fields.size >= SIZE_LIMIT && !record.fields.has(key)) raiseTooLarge()
  record.fields.set(key, value)
  m.recordField(record.id, key, value)
}

/** `RecordMerge`: `( rec other -- rec )`, one field write per copied key. */
export function recordMerge(m: MachineState): void {
  const other = m.stack.pop() as Value
  const record = recordUnder(m.stack)
  if (!isRecord(other)) raise('R024', `cannot spread ${articleType(other)} into a record`)
  let added = 0
  for (const key of other.fields.keys()) if (!record.fields.has(key)) added++
  if (record.fields.size + added > SIZE_LIMIT) raiseTooLarge()
  for (const [key, value] of Array.from(other.fields)) {
    record.fields.set(key, value)
    m.recordField(record.id, key, value)
  }
}

/** `Interp n`: `( v1…vn -- string )`, the concatenation of `show(vi)`. */
export function interpolate(m: MachineState, count: number): void {
  const stack = m.stack
  const start = stack.length - count
  let text = ''
  for (let i = start; i < stack.length; i++) {
    const piece = showWithin(stack[i] as Value, SIZE_LIMIT - text.length)
    if (piece === null) raiseTooLarge()
    text += piece
  }
  stack.length = start
  stack.push(text)
}
