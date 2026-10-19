/**
 * The recording hooks (ARCHITECTURE §6.7): every VM event is appended to the columnar event log,
 * every `print` to the output list, every allocation to the allocation-time table.
 */
import type { ListOp, OutputEvent, WriteTarget } from './api-types'
import type { HeapObject, Value, VMHooks } from './runtime-types'
import {
  AllocTimes,
  AllocType,
  EventCode,
  EventColumns,
  ListOpCode,
  TargetCode,
} from './trace-columns'

export class TraceSink implements VMHooks {
  constructor(
    readonly events: EventColumns,
    readonly allocs: AllocTimes,
    /** Owned by this sink's recording (copied for extensions). */
    readonly outputs: OutputEvent[],
    /** Number of events written so far (the next row). */
    public eventCount: number,
  ) {}

  output(time: number, text: string): void {
    this.outputs.push({ time, text })
  }

  write(time: number, kind: 'declare' | 'write', target: WriteTarget, value: Value): void {
    const code = kind === 'declare' ? EventCode.declare : EventCode.write
    const events = this.events
    const at = this.eventCount++
    switch (target.kind) {
      case 'local':
        events.set(at, time, code, TargetCode.local, target.frameUid, target.slot, value)
        break
      case 'global':
        events.set(at, time, code, TargetCode.global, 0, events.strings.intern(target.name), value)
        break
      case 'field':
        events.set(
          at,
          time,
          code,
          TargetCode.field,
          target.objectId,
          events.strings.intern(target.key),
          value,
        )
        break
      case 'element':
        events.set(at, time, code, TargetCode.element, target.objectId, target.index, value)
        break
      case 'cell':
        events.set(at, time, code, TargetCode.cell, target.cellId, 0, value)
        break
      default:
        events.set(at, time, code, TargetCode.object, target.objectId, 0, value)
    }
  }

  listOp(
    time: number,
    listId: number,
    op: ListOp,
    index: number,
    count: number,
    value: Value,
  ): void {
    const at = this.eventCount++
    this.events.set(at, time, EventCode.list, TargetCode.object, listId, index, value)
    this.events.setExtra(at, ListOpCode[op], count)
  }

  fieldDelete(time: number, recordId: number, key: string): void {
    const events = this.events
    const at = this.eventCount++
    events.set(
      at,
      time,
      EventCode.delete,
      TargetCode.field,
      recordId,
      events.strings.intern(key),
      null,
    )
  }

  alloc(time: number, object: HeapObject): void {
    const at = this.eventCount++
    this.allocs.set(object.id, time)
    if (object.type === 'cell') {
      this.events.set(at, time, EventCode.alloc, TargetCode.object, object.id, object.slot, object)
      this.events.setExtra(at, AllocType.cell, object.ownerFrameUid)
    } else {
      this.events.set(at, time, EventCode.alloc, TargetCode.object, object.id, 0, object)
    }
  }

  cellClosed(time: number, cellId: number, ownerFrameUid: number, slot: number): void {
    const at = this.eventCount++
    this.events.set(at, time, EventCode.cellClosed, TargetCode.cell, cellId, slot, null)
    this.events.setExtra(at, 0, ownerFrameUid)
  }

  /** Drops everything emitted at `time` or later (the failing step, ARCHITECTURE §7.1.2). */
  discardFrom(time: number): void {
    const times = this.events.times
    while (this.eventCount > 0 && times[this.eventCount - 1]! >= time) this.eventCount--
    while (this.outputs.length > 0 && this.outputs[this.outputs.length - 1]!.time >= time) {
      this.outputs.pop()
    }
  }
}
