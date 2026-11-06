/**
 * What-if edits (ARCHITECTURE §7.5): finds where an edit's target lives in a VM positioned at the
 * fork step, and writes the new value there. This is the only code outside the VM that changes VM
 * state, and it only ever touches a fork's own VM, before that VM resumes.
 */
import type { EditValue, WriteTarget } from './api-types'
import { functionDisplayName } from './bytecode'
import { liveLocals } from './inspector'
import { cellTarget, findReachable, walk } from './inspector-heap'
import type { CellObj, ListObj, RecordObj, Value, VM } from './runtime-types'

/** A place an edit writes to, with the target its `write` event is recorded under. */
export type EditSlot = { readonly target: WriteTarget } & (
  | { readonly kind: 'stack'; readonly index: number }
  | { readonly kind: 'global'; readonly name: string }
  | { readonly kind: 'item'; readonly list: ListObj; readonly index: number }
  | { readonly kind: 'field'; readonly record: RecordObj; readonly key: string }
  | { readonly kind: 'cell'; readonly cell: CellObj }
)

/** True for the values an edit may write: nil, bools, numbers and strings. */
export function isEditValue(value: unknown): value is EditValue {
  const type = typeof value
  return value === null || type === 'boolean' || type === 'number' || type === 'string'
}

/** Where `target` lives in `vm` (positioned at step `time`), or why it cannot be edited there. */
export function resolveEditTarget(vm: VM, target: WriteTarget, time: number): EditSlot | string {
  const at = `at step ${time}`
  switch (target.kind) {
    case 'global':
      return vm.globals.has(target.name)
        ? { kind: 'global', name: target.name, target }
        : `global '${target.name}' is not defined ${at}`
    case 'local':
      return resolveLocal(vm, target.frameUid, target.slot, at)
    case 'element':
      return resolveElement(vm, target.objectId, target.index, at)
    case 'field':
      return resolveField(vm, target.objectId, target.key, at)
    case 'cell':
      return resolveCell(vm, target.cellId, at)
    default:
      return 'a whole object cannot be edited: edit one of its elements or fields'
  }
}

function resolveLocal(vm: VM, frameUid: number, slot: number, at: string): EditSlot | string {
  const frames = vm.frames
  const index = frames.findIndex((frame) => frame.uid === frameUid)
  if (index < 0) return `no active call has frame uid ${frameUid} ${at}`
  const frame = frames[index]!
  const regionEnd = index === frames.length - 1 ? vm.stack.length : frames[index + 1]!.base
  const proto = frame.closure.proto
  const local = liveLocals(proto.debug.locals, frame, regionEnd).find((l) => l.slot === slot)
  if (local === undefined || local.hidden) {
    return `slot ${slot} of ${functionDisplayName(proto)} holds no variable ${at}`
  }
  return { kind: 'stack', index: frame.base + slot, target: { kind: 'local', frameUid, slot } }
}

function resolveElement(vm: VM, objectId: number, index: number, at: string): EditSlot | string {
  const list = findReachable(vm, objectId)
  if (list?.type !== 'list') return `no list with id ${objectId} is reachable ${at}`
  if (!Number.isInteger(index) || index < 0 || index >= list.items.length) {
    return `index ${index} is outside the list (length ${list.items.length}) ${at}`
  }
  return { kind: 'item', list, index, target: { kind: 'element', objectId, index } }
}

function resolveField(vm: VM, objectId: number, key: string, at: string): EditSlot | string {
  const record = findReachable(vm, objectId)
  if (record?.type !== 'record') return `no record with id ${objectId} is reachable ${at}`
  if (!record.fields.has(key)) return `the record has no field '${key}' ${at}`
  return { kind: 'field', record, key, target: { kind: 'field', objectId, key } }
}

function resolveCell(vm: VM, cellId: number, at: string): EditSlot | string {
  const cell = findCell(vm, cellId)
  if (cell === null) return `no captured variable with cell id ${cellId} is reachable ${at}`
  // An open cell aliases its owner's stack slot (§6.7), so the edit goes there.
  return cell.open
    ? { kind: 'stack', index: cell.stackIndex, target: cellTarget(cell) }
    : { kind: 'cell', cell, target: cellTarget(cell) }
}

/** A cell captured by a reachable closure. */
function findCell(vm: VM, cellId: number): CellObj | null {
  let found: CellObj | null = null
  walk(vm, Infinity, (object) => {
    if (object.type === 'closure')
      found = object.upvalues.find((cell) => cell.id === cellId) ?? null
    return found === null
  })
  return found
}

/** Writes `value` into the slot, changing the VM state in place. */
export function writeEdit(vm: VM, slot: EditSlot, value: EditValue): void {
  switch (slot.kind) {
    case 'stack':
      ;(vm.stack as Value[])[slot.index] = value
      break
    case 'global':
      ;(vm.globals as Map<string, Value>).set(slot.name, value)
      break
    case 'item':
      slot.list.items[slot.index] = value
      break
    case 'field':
      slot.record.fields.set(slot.key, value)
      break
    case 'cell':
      slot.cell.value = value
  }
}
