/**
 * The `NativeContext` the VM hands to natives (ARCHITECTURE §6.4): a thin view over the machine
 * state, so natives allocate, mutate and record events exactly like the VM's own operations.
 */
import type { RuntimeErrorCode } from './diagnostics'
import type { ListObj, NativeContext, RangeObj, RecordObj, Value } from './runtime-types'
import { VMFailure } from './vm-errors'
import type { MachineState } from './vm-state'

export class MachineContext implements NativeContext {
  constructor(private readonly machine: MachineState) {}

  get time(): number {
    return this.machine.time
  }

  print(text: string): void {
    this.machine.emitOutput(text)
  }

  newList(items: Value[]): ListObj {
    return this.machine.newList(items)
  }

  newRecord(fields: Map<string, Value>): RecordObj {
    return this.machine.newRecord(fields)
  }

  newRange(start: number, end: number, step: number, inclusive: boolean): RangeObj {
    return this.machine.newRange(start, end, step, inclusive)
  }

  listAppend(list: ListObj, value: Value): void {
    this.machine.appendItem(list, value)
  }

  listInsert(list: ListObj, index: number, value: Value): void {
    this.machine.insertItem(list, index, value)
  }

  listRemove(list: ListObj, index: number): Value {
    return this.machine.removeItem(list, index)
  }

  listPop(list: ListObj): Value {
    return this.machine.popItem(list)
  }

  recordDelete(record: RecordObj, key: string): Value {
    return this.machine.deleteField(record, key)
  }

  charge(units: number): void {
    this.machine.charge(units)
  }

  random(): number {
    return this.machine.nextRandom()
  }

  seed(n: number): void {
    this.machine.reseed(n)
  }

  fail(code: RuntimeErrorCode, message: string, hint?: string): never {
    throw new VMFailure(code, message, hint)
  }
}
