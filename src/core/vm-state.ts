/**
 * The mutable VM record (ARCHITECTURE §6.2) with the primitives every operation shares: allocation
 * with ids and `alloc` events, cells, list/record mutations with their events, the write barrier
 * for incremental snapshots, and the generator.
 *
 * Event helpers take primitive arguments and build the event target only when hooks are attached,
 * so running without hooks allocates nothing extra. Hooks never influence the state.
 *
 * **Write barrier** (§6.8): once the machine has taken or restored a snapshot (its `base`), every
 * in-place change of an object that existed then (id below `logBelow`) is appended to `changeLog`
 * as a pair `(object, detail)`, so the next snapshot copies only what changed. Details: for a list,
 * an element index (`i >= 0`) or a changed tail (`-1 - from`, the length may change too); for a
 * record, the key written, or `null` when a key was deleted; otherwise 0. While no snapshot is
 * involved `logBelow` is 0, so the barrier is one comparison that never passes.
 */
import type { ListOp, RuntimeErrorInfo, SchedulePolicy } from './api-types'
import { DEFAULT_QUANTUM, DEFAULT_SCHEDULE_SEED, DEFAULT_SEED } from './api-types'
import type { FunctionProto, Program } from './bytecode'
import { InternalError } from './diagnostics'
import type {
  CellObj,
  ChannelObj,
  ClosureObj,
  Frame,
  HeapObject,
  IteratorObj,
  ListObj,
  NativeContext,
  RangeObj,
  RecordObj,
  Task,
  TaskObj,
  Value,
  VMHooks,
  VMOptions,
  VMStatus,
} from './runtime-types'
import { MEMORY_LIMIT } from './values-guards'
import { MachineContext } from './vm-context'
import { MEMORY_LIMIT_EXCEEDED, raise } from './vm-errors'
import { Request } from './vm-request'
import type { MachineSnapshot, RecordPositions } from './vm-snapshot'
import type { Ref } from './vm-snapshot-frozen'

/** The change log never grows beyond this many pairs, or twice the base snapshot's values. */
const MIN_LOG_PAIRS = 1 << 16

/** A pending rest binding of a list pattern: materialized only when the whole pattern matched. */
export class RestSlice {
  constructor(
    readonly list: ListObj,
    readonly start: number,
    readonly end: number,
  ) {}
}

export type Binding = Value | RestSlice

export class MachineState {
  readonly program: Program
  /**
   * In BUILTIN_NAMES order. `DefineBuiltin` stores into this array, which is the caller's own
   * `options.builtins` (library initialization reads the defined closures back from it).
   */
  readonly builtins: Value[]
  readonly libraryProtos: readonly FunctionProto[]
  readonly context: NativeContext
  time = 0
  status: VMStatus = 'running'
  error: RuntimeErrorInfo | null = null
  hooks: VMHooks | null = null
  stack: Value[]
  frames: Frame[]
  globals = new Map<string, Value>()
  openCells: CellObj[] = []
  nextObjectId = 2
  nextFrameUid = 2
  rngState: number
  /** Units charged against the allocation budget so far (SPEC §10.5); never decreases. */
  allocated = 0
  /**
   * Elements visited by single steps without allocating (scans, sorts, deep comparisons). With
   * `time` and `allocated` it measures the work done so far (`work`, ARCHITECTURE §7.1.4).
   */
  scanned = 0
  /** Scratch buffer for pattern bindings, reused to keep matching allocation-free. */
  readonly bindings: Binding[] = []

  // Tasks (ARCHITECTURE §6.11). While the program never spawned, `tasks` is null and nothing below
  // costs anything.
  /** Every task in id order, or null while the main script is the only one. */
  tasks: Task[] | null = null
  /** The running task (its arrays are `stack`, `frames` and `openCells`), or null. */
  current: Task | null = null
  /** Unfinished tasks (R030 limits them). */
  liveTasks = 0
  /** Set by a task native that needs a switch (`Request`); handled by the step loop. */
  request: number = Request.none
  /** The time at which the random policy preempts the running task; Infinity otherwise. */
  preemptAt = Infinity
  /** The scheduler's generator state, separate from the program's (`rngState`). */
  schedState: number
  readonly policy: SchedulePolicy
  readonly quantum: number

  // Write barrier and incremental snapshots (see the module comment).
  /** In-place changes of objects with smaller ids are logged; 0 while no base snapshot is kept. */
  logBelow = 0
  /** `(object, detail)` pairs since `base`. */
  readonly changeLog: unknown[] = []
  /** When `changeLog` reaches this length, logging stops and the next snapshot is a full one. */
  logLimit = 0
  /** The snapshot the live state derives from (with `changeLog`), or null. */
  base: MachineSnapshot | null = null
  /** `Ref`s by id, shared by this machine's snapshots. */
  readonly refs: Ref[] = []
  /** Key positions of large records in the latest snapshot (vm-snapshot.ts). */
  readonly positions = new Map<number, RecordPositions>()
  /**
   * After a restore: the live objects by id it created or reused (each matches its copy in `base`
   * unless the change log names it), for delta restores; null otherwise.
   */
  live: Map<number, HeapObject> | null = null

  constructor(program: Program, options: VMOptions) {
    this.program = program
    // Deliberately not copied: see `builtins` above.
    this.builtins = options.builtins as Value[]
    this.libraryProtos = options.libraryProtos
    this.rngState = (options.seed ?? DEFAULT_SEED) >>> 0
    const schedule = options.schedule
    this.policy = schedule?.policy ?? 'round-robin'
    this.quantum = Math.max(1, Math.floor(schedule?.quantum ?? DEFAULT_QUANTUM))
    this.schedState = (schedule?.seed ?? DEFAULT_SCHEDULE_SEED) >>> 0
    const script: ClosureObj = { type: 'closure', id: 1, proto: program.script, upvalues: [] }
    this.stack = [script]
    this.frames = [{ closure: script, ip: 0, base: 0, uid: 1 }]
    this.context = new MachineContext(this)
  }

  /** Steps plus allocation and scan units: the replay cost so far (ARCHITECTURE §7.1.4). */
  get work(): number {
    return this.time + this.allocated + this.scanned
  }

  // -------------------------------------------------------------------------------------------
  // Write barrier (§6.8)

  /** Logs a change of a list element. */
  noteElement(list: ListObj, index: number): void {
    if (list.id < this.logBelow) this.logChange(list, index)
  }

  /** Logs a change of a list's tail from `from` on, including its length. */
  noteTail(list: ListObj, from: number): void {
    if (list.id < this.logBelow) this.logChange(list, -1 - from)
  }

  /** Logs a write of `key` (or, for `null`, a deletion) in a record. */
  noteField(record: RecordObj, key: string | null): void {
    if (record.id < this.logBelow) this.logChange(record, key)
  }

  /** Logs a change of a cell or an iterator, or any change that needs a whole new copy. */
  noteObject(object: HeapObject): void {
    if (object.id < this.logBelow) {
      const detail = object.type === 'list' ? -1 : object.type === 'record' ? null : 0
      this.logChange(object, detail)
    }
  }

  logChange(object: HeapObject, detail: number | string | null): void {
    const log = this.changeLog
    log.push(object, detail)
    if (log.length >= this.logLimit) this.forgetBase()
  }

  /** Starts logging relative to `base` (a snapshot just taken or restored). */
  trackFrom(base: MachineSnapshot): void {
    this.base = base
    this.changeLog.length = 0
    this.logBelow = base.nextObjectId
    this.logLimit = 2 * Math.max(MIN_LOG_PAIRS, base.tableValues)
  }

  /** Stops logging: the next snapshot copies everything (a replay that ran on too long). */
  forgetBase(): void {
    this.base = null
    this.changeLog.length = 0
    this.logBelow = 0
    this.positions.clear()
    this.live = null
  }

  // -------------------------------------------------------------------------------------------
  // Allocation

  /**
   * Charges `units` (list items, record entries or string code units) against the run's allocation
   * budget, raising R025 `memory limit exceeded` before the allocation when it would run out.
   */
  charge(units: number): void {
    const total = this.allocated + units
    if (total > MEMORY_LIMIT) raise('R025', MEMORY_LIMIT_EXCEEDED)
    this.allocated = total
  }

  newList(items: Value[]): ListObj {
    this.charge(items.length)
    return this.emitted({ type: 'list', id: this.nextObjectId++, items })
  }

  newRecord(fields: Map<string, Value>): RecordObj {
    this.charge(fields.size)
    return this.emitted({ type: 'record', id: this.nextObjectId++, fields })
  }

  newRange(start: number, end: number, step: number, inclusive: boolean): RangeObj {
    return this.emitted({ type: 'range', id: this.nextObjectId++, start, end, step, inclusive })
  }

  newClosure(proto: FunctionProto): ClosureObj {
    return this.emitted({ type: 'closure', id: this.nextObjectId++, proto, upvalues: [] })
  }

  newIterator(source: Value, keys: readonly string[] | null): IteratorObj {
    return this.emitted({ type: 'iterator', id: this.nextObjectId++, source, position: 0, keys })
  }

  newTaskObject(task: number, name: string): TaskObj {
    return this.emitted({ type: 'task', id: this.nextObjectId++, task, name })
  }

  newChannel(capacity: number): ChannelObj {
    return this.emitted({
      type: 'channel',
      id: this.nextObjectId++,
      capacity,
      items: [],
      closed: false,
    })
  }

  private emitted<T extends HeapObject>(object: T): T {
    if (this.hooks !== null) this.hooks.alloc(this.time, object)
    return object
  }

  // -------------------------------------------------------------------------------------------
  // Cells (upvalues), clox style: open cells alias stack slots and are sorted by stack index.

  /** The open cell for `slot` of the frame, created if needed. */
  captureLocal(frame: Frame, slot: number): CellObj {
    const stackIndex = frame.base + slot
    const cells = this.openCells
    let i = cells.length - 1
    while (i >= 0 && cells[i]!.stackIndex > stackIndex) i--
    if (i >= 0 && cells[i]!.stackIndex === stackIndex) return cells[i]!
    const cell: CellObj = {
      type: 'cell',
      id: this.nextObjectId++,
      open: true,
      stackIndex,
      stack: this.stack,
      value: null,
      ownerFrameUid: frame.uid,
      slot,
    }
    cells.splice(i + 1, 0, cell)
    return this.emitted(cell)
  }

  /** Closes every open cell whose stack index is `>= stackIndex`, highest first. */
  closeCellsFrom(stackIndex: number): void {
    const cells = this.openCells
    while (cells.length > 0) {
      const cell = cells[cells.length - 1]!
      if (cell.stackIndex < stackIndex) return
      cells.pop()
      cell.value = this.stack[cell.stackIndex] as Value
      cell.open = false
      if (cell.id < this.logBelow) this.logChange(cell, 0)
      if (this.hooks !== null) {
        this.hooks.cellClosed(this.time, cell.id, cell.ownerFrameUid, cell.slot)
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Events

  recordLocal(kind: 'declare' | 'write', frameUid: number, slot: number, value: Value): void {
    if (this.hooks !== null)
      this.hooks.write(this.time, kind, { kind: 'local', frameUid, slot }, value)
  }

  recordGlobal(kind: 'declare' | 'write', name: string, value: Value): void {
    if (this.hooks !== null) this.hooks.write(this.time, kind, { kind: 'global', name }, value)
  }

  recordField(objectId: number, key: string, value: Value): void {
    if (this.hooks !== null) {
      this.hooks.write(this.time, 'write', { kind: 'field', objectId, key }, value)
    }
  }

  recordElement(objectId: number, index: number, value: Value): void {
    if (this.hooks !== null) {
      this.hooks.write(this.time, 'write', { kind: 'element', objectId, index }, value)
    }
  }

  /** An upvalue write: an open cell is reported as its owner's local slot (ARCHITECTURE §6.7). */
  recordCell(cell: CellObj, value: Value): void {
    if (this.hooks === null) return
    if (cell.open) this.recordLocal('write', cell.ownerFrameUid, cell.slot, value)
    else this.hooks.write(this.time, 'write', { kind: 'cell', cellId: cell.id }, value)
  }

  recordListOp(listId: number, op: ListOp, index: number, count: number, value: Value): void {
    if (this.hooks !== null) this.hooks.listOp(this.time, listId, op, index, count, value)
  }

  emitOutput(text: string): void {
    if (this.hooks !== null) this.hooks.output(this.time, text)
  }

  // -------------------------------------------------------------------------------------------
  // List and record mutations (callers check SPEC §10.5 limits and index ranges first)

  appendItem(list: ListObj, value: Value): void {
    const index = list.items.length
    this.charge(1)
    list.items.push(value)
    if (list.id < this.logBelow) this.logChange(list, -1 - index)
    this.recordListOp(list.id, 'append', index, 1, value)
  }

  insertItem(list: ListObj, index: number, value: Value): void {
    if (!(index >= 0 && index <= list.items.length)) throw new InternalError('insert out of range')
    this.charge(1)
    list.items.splice(index, 0, value)
    this.noteTail(list, index)
    this.recordListOp(list.id, 'insert', index, 1, value)
  }

  removeItem(list: ListObj, index: number): Value {
    if (!(index >= 0 && index < list.items.length)) throw new InternalError('remove out of range')
    const removed = list.items.splice(index, 1)[0] as Value
    this.noteTail(list, index)
    this.recordListOp(list.id, 'remove', index, 1, removed)
    return removed
  }

  popItem(list: ListObj): Value {
    if (list.items.length === 0) throw new InternalError('pop from an empty list')
    const removed = list.items.pop() as Value
    this.noteTail(list, list.items.length)
    this.recordListOp(list.id, 'pop', list.items.length, 1, removed)
    return removed
  }

  deleteField(record: RecordObj, key: string): Value {
    const old = record.fields.get(key)
    if (old === undefined) return null
    record.fields.delete(key)
    this.noteField(record, null)
    if (this.hooks !== null) this.hooks.fieldDelete(this.time, record.id, key)
    return old
  }

  // -------------------------------------------------------------------------------------------
  // The generator (SPEC §10.3): mulberry32 over a uint32 state.

  nextRandom(): number {
    this.rngState = advance(this.rngState)
    return draw(this.rngState)
  }

  reseed(seed: number): void {
    this.rngState = seed >>> 0
  }

  /** The scheduler's draw in [0, 1): mulberry32 over its own state, like `nextRandom`. */
  nextScheduleRandom(): number {
    this.schedState = advance(this.schedState)
    return draw(this.schedState)
  }
}

/** mulberry32's state step (SPEC §10.3). */
function advance(state: number): number {
  return (state + 0x6d2b79f5) >>> 0
}

/** mulberry32's draw in [0, 1) from an advanced state (SPEC §10.3). */
function draw(state: number): number {
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
