/**
 * The bytecode VM (ARCHITECTURE §6): `createVM` wires the machine state, the dispatch loop and
 * snapshots behind the `VM` interface of runtime-types.ts.
 */
import type { RuntimeErrorInfo } from './api-types'
import type { FunctionProto, Program } from './bytecode'
import { InternalError } from './diagnostics'
import type {
  CellObj,
  Frame,
  Value,
  VM,
  VMHooks,
  VMOptions,
  VMSnapshot,
  VMStatus,
} from './runtime-types'
import { execute } from './vm-exec'
import { MachineSnapshot, type MachineRecord, copyRecord } from './vm-snapshot'
import { MachineState } from './vm-state'

export function createVM(program: Program, options: VMOptions): VM {
  return new MachineVM(program, options)
}

class MachineVM implements VM {
  private readonly machine: MachineState

  constructor(
    readonly program: Program,
    options: VMOptions,
  ) {
    this.machine = new MachineState(program, options)
  }

  get time(): number {
    return this.machine.time
  }

  get status(): VMStatus {
    return this.machine.status
  }

  get error(): RuntimeErrorInfo | null {
    return this.machine.error
  }

  get hooks(): VMHooks | null {
    return this.machine.hooks
  }

  set hooks(hooks: VMHooks | null) {
    this.machine.hooks = hooks
  }

  get stack(): readonly Value[] {
    return this.machine.stack
  }

  get frames(): readonly Frame[] {
    return this.machine.frames
  }

  get globals(): ReadonlyMap<string, Value> {
    return this.machine.globals
  }

  get openCells(): readonly CellObj[] {
    return this.machine.openCells
  }

  protoById(id: number): FunctionProto {
    const m = this.machine
    const proto =
      id < this.program.firstProtoId
        ? m.libraryProtos[id]
        : this.program.protos[id - this.program.firstProtoId]
    if (proto === undefined || proto.id !== id) throw new InternalError(`no proto with id ${id}`)
    return proto
  }

  step(): void {
    if (this.machine.status !== 'running') {
      throw new InternalError(`step() on a VM whose status is '${this.machine.status}'`)
    }
    execute(this.machine, this.machine.time + 1)
  }

  runUntil(t: number): void {
    execute(this.machine, t)
  }

  snapshot(): VMSnapshot {
    const { record, size } = copyRecord(this.currentRecord())
    return new MachineSnapshot(record.time, size, this.program, record)
  }

  restore(snapshot: VMSnapshot): void {
    if (!(snapshot instanceof MachineSnapshot) || snapshot.program !== this.program) {
      throw new InternalError('restore() needs a snapshot taken from a VM of the same program')
    }
    const { record } = copyRecord(snapshot.record)
    const m = this.machine
    m.stack = record.stack
    m.frames = record.frames
    m.openCells = record.openCells
    m.globals = record.globals
    m.time = record.time
    m.nextObjectId = record.nextObjectId
    m.nextFrameUid = record.nextFrameUid
    m.rngState = record.rngState
    m.allocated = record.allocated
    m.status = record.status
    m.error = record.error
  }

  private currentRecord(): MachineRecord {
    const m = this.machine
    return {
      stack: m.stack,
      frames: m.frames,
      openCells: m.openCells,
      globals: m.globals,
      time: m.time,
      nextObjectId: m.nextObjectId,
      nextFrameUid: m.nextFrameUid,
      rngState: m.rngState,
      allocated: m.allocated,
      status: m.status,
      error: m.error,
    }
  }
}
