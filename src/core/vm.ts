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
  HeapObject,
  Task,
  Value,
  VM,
  VMHooks,
  VMOptions,
  VMSnapshot,
  VMStatus,
} from './runtime-types'
import { execute } from './vm-exec'
import { MachineSnapshot, restoreSnapshot, takeSnapshot } from './vm-snapshot'
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

  get tasks(): readonly Readonly<Task>[] | null {
    return this.machine.tasks
  }

  get taskId(): number {
    return this.machine.current?.id ?? 1
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

  get work(): number {
    // Read once per recorded step: summed here rather than through MachineState's getter.
    const m = this.machine
    return m.time + m.allocated + m.scanned
  }

  snapshot(): VMSnapshot {
    return takeSnapshot(this.machine)
  }

  restore(snapshot: VMSnapshot): void {
    if (!(snapshot instanceof MachineSnapshot) || snapshot.program !== this.program) {
      throw new InternalError('restore() needs a snapshot taken from a VM of the same program')
    }
    restoreSnapshot(this.machine, snapshot)
  }

  noteEdit(object: HeapObject): void {
    this.machine.noteObject(object)
  }
}
