/**
 * Runtime contract between the VM, the natives, the library loader and the time-travel engine
 * (docs/ARCHITECTURE.md §6). The VM and natives mutate these objects internally; every other module
 * treats them as read-only.
 */
import type { ListOp, RuntimeErrorInfo, ScheduleOptions, WriteTarget } from './api-types'
import type { FunctionProto, Program } from './bytecode'
import type { RuntimeErrorCode } from './diagnostics'

// ---------------------------------------------------------------------------------------------
// Values

/** nil is `null`; bools, numbers and strings are JS primitives. */
export type Value = null | boolean | number | string | HeapObject

export type HeapObject =
  | ListObj
  | RecordObj
  | ClosureObj
  | NativeObj
  | RangeObj
  | IteratorObj
  | CellObj
  | TaskObj
  | ChannelObj

export interface ListObj {
  readonly type: 'list'
  readonly id: number
  readonly items: Value[]
}

export interface RecordObj {
  readonly type: 'record'
  readonly id: number
  /** Insertion-ordered. */
  readonly fields: Map<string, Value>
}

/** A user or library function. Library closures (builtins) have negative ids. */
export interface ClosureObj {
  readonly type: 'closure'
  readonly id: number
  readonly proto: FunctionProto
  readonly upvalues: CellObj[]
}

export type NativeFn = (ctx: NativeContext, args: readonly Value[]) => Value

export interface NativeObj {
  readonly type: 'native'
  /** Negative: `-(builtinIndex + 1)`. */
  readonly id: number
  readonly name: string
  readonly minArgs: number
  /** `Infinity` for variadic natives. */
  readonly maxArgs: number
  readonly fn: NativeFn
}

/** Immutable; shared between snapshots. */
export interface RangeObj {
  readonly type: 'range'
  readonly id: number
  readonly start: number
  readonly end: number
  readonly step: number
  readonly inclusive: boolean
}

/** A `for` loop's hidden iterator (SPEC §8.3). */
export interface IteratorObj {
  readonly type: 'iterator'
  readonly id: number
  /** The list, range or string being iterated; for records, the record. */
  readonly source: Value
  /** Index of the next element (for ranges: the next k). */
  position: number
  /** For records: the key snapshot taken when the loop started; otherwise null. */
  readonly keys: readonly string[] | null
}

/**
 * An upvalue. Open: it aliases `stack[stackIndex]` of the task that created it (`stack`, which is
 * that task's stack array, so a closure running in another task reads the right one). Closed: it
 * holds `value`, and `stack` means nothing.
 */
export interface CellObj {
  readonly type: 'cell'
  readonly id: number
  open: boolean
  stackIndex: number
  stack: Value[]
  value: Value
  /** The frame and slot the cell was created for (provenance aliasing, ARCHITECTURE §7.3). */
  readonly ownerFrameUid: number
  readonly slot: number
}

/**
 * A task handle (SPEC §10.6): what `spawn` and `current_task` return. Immutable and shared between
 * snapshots like a range; the task's state lives in the machine (`Task`).
 */
export interface TaskObj {
  readonly type: 'task'
  readonly id: number
  /** The task number: 1 for the main script, then 2, 3, … in spawn order. */
  readonly task: number
  /** Display name of the function the task runs (`main` for the script). */
  readonly name: string
}

/** A channel (SPEC §10.6). Capacity 0 is an unbuffered rendezvous. */
export interface ChannelObj {
  readonly type: 'channel'
  readonly id: number
  readonly capacity: number
  /** Buffered values, oldest first (at most `capacity`). */
  readonly items: Value[]
  closed: boolean
}

export type TaskStatus = 'runnable' | 'blocked' | 'done'

/** What a blocked task waits for. */
export type TaskWait =
  | { readonly kind: 'send'; readonly channel: ChannelObj }
  | { readonly kind: 'recv'; readonly channel: ChannelObj }
  /** `wait(t)`: the task number it waits for. */
  | { readonly kind: 'join'; readonly task: number }

/**
 * One task of the machine (ARCHITECTURE §6.11). The machine's `stack`, `frames` and `openCells` are
 * the current task's arrays. A blocked task's top frame stands on the `Call` that blocked, with the
 * callee and arguments still on its stack.
 */
export interface Task {
  readonly id: number
  readonly name: string
  stack: Value[]
  frames: Frame[]
  openCells: CellObj[]
  status: TaskStatus
  wait: TaskWait | null
  /** The step at which the task last blocked (waiters are served in this order). */
  since: number
  /** The function's result once the task is done. */
  result: Value
  /** The handle, created by `spawn` (or by `current_task` for the main task). */
  object: TaskObj | null
}

export interface Frame {
  readonly closure: ClosureObj
  /** Index of the next instruction to execute in `closure.proto.code`. */
  ip: number
  /** Stack index of slot 0 (the callee). */
  readonly base: number
  readonly uid: number
}

// ---------------------------------------------------------------------------------------------
// Natives

/** What a native may do (ARCHITECTURE §6.4). Natives never call back into user code. */
export interface NativeContext {
  /** Index of the executing step. */
  readonly time: number
  /** Emits one output event. */
  print(text: string): void
  /** Allocation helpers: assign the next object id and record an `alloc` event. */
  newList(items: Value[]): ListObj
  newRecord(fields: Map<string, Value>): RecordObj
  newRange(start: number, end: number, step: number, inclusive: boolean): RangeObj
  /** Mutation helpers: perform the change and record its events (ARCHITECTURE §6.7). */
  listAppend(list: ListObj, value: Value): void
  /** `index` is normalized (0..=length). */
  listInsert(list: ListObj, index: number, value: Value): void
  /** `index` is normalized (0..length-1); returns the removed item. */
  listRemove(list: ListObj, index: number): Value
  listPop(list: ListObj): Value
  /** Removes `key` if present and returns its old value (or nil). */
  recordDelete(record: RecordObj, key: string): Value
  /**
   * Charges a freshly built string's code units (or other allocation units) against the run's
   * allocation budget (SPEC §10.5); raises R025 when it runs out.
   */
  charge(units: number): void
  /**
   * Reports elements visited without allocating (comparisons of a sort, items of a scan), so the
   * recorder's snapshot cadence counts the work of this step (ARCHITECTURE §7.1.4).
   */
  scan(units: number): void
  /** The deterministic generator (SPEC §10.3). */
  random(): number
  seed(n: number): void
  /** Raises a runtime error at the current call. */
  fail(code: RuntimeErrorCode, message: string, hint?: string): never
  /** Tasks and channels (SPEC §10.6); blocking operations ask the VM to switch tasks. */
  readonly tasks: TaskOps
}

/**
 * What task natives ask of the machine. None of them calls user code: `spawn` only prepares the new
 * task's first frame, and an operation that must wait marks the current task blocked and leaves a
 * request the VM's `Call` path handles after the native returns (ARCHITECTURE §6.11).
 */
export interface TaskOps {
  /** Starts a task that calls `fn(...args)`; `fn` is a user or library function. */
  spawn(fn: ClosureObj, args: readonly Value[]): TaskObj
  channel(capacity: number): ChannelObj
  /** Completes at once or blocks the current task. */
  send(channel: ChannelObj, value: Value): void
  /** The value received; when the task blocks instead, the return value is ignored. */
  recv(channel: ChannelObj): Value
  close(channel: ChannelObj): void
  /** The task's result, or blocks until it is done. */
  wait(task: TaskObj): Value
  /** Lets another runnable task run. */
  yieldTask(): void
  current(): TaskObj
}

// ---------------------------------------------------------------------------------------------
// The VM

/** Recording callbacks; pure observers (ARCHITECTURE §6.7). `time` is the executing step. */
export interface VMHooks {
  output(time: number, text: string): void
  write(time: number, kind: 'declare' | 'write', target: WriteTarget, value: Value): void
  listOp(time: number, listId: number, op: ListOp, index: number, count: number, value: Value): void
  fieldDelete(time: number, recordId: number, key: string): void
  alloc(time: number, object: HeapObject): void
  cellClosed(time: number, cellId: number, ownerFrameUid: number, slot: number): void
}

/** Opaque copy of the whole VM state (ARCHITECTURE §6.8). */
export interface VMSnapshot {
  readonly time: number
  /** Number of values this snapshot copied; drives the recorder's snapshot cadence. */
  readonly size: number
  /** About the number of values `restore` rebuilds (absent: `size`); also drives the cadence. */
  readonly restoreSize?: number
  /**
   * The values this snapshot holds that `earlier` (a snapshot taken before it by the same line of
   * VMs) does not share with it; all of them for null. Absent: `size` (nothing is shared).
   */
  retainedSince?(earlier: VMSnapshot | null): number
}

export type VMStatus = 'running' | 'finished' | 'error'

export interface VMOptions {
  /** In BUILTIN_NAMES order. */
  readonly builtins: readonly Value[]
  /** Library protos; their ids are 0 .. libraryProtos.length - 1. */
  readonly libraryProtos: readonly FunctionProto[]
  /** Default DEFAULT_SEED. */
  readonly seed?: number
  /** How tasks interleave (SPEC §10.6). Default round-robin. */
  readonly schedule?: ScheduleOptions
}

export interface VM {
  readonly program: Program
  /** Steps executed so far: the index of the next step. */
  readonly time: number
  readonly status: VMStatus
  readonly error: RuntimeErrorInfo | null
  hooks: VMHooks | null
  readonly stack: readonly Value[]
  /** Outermost first. */
  readonly frames: readonly Frame[]
  /** Defined globals in definition order. */
  readonly globals: ReadonlyMap<string, Value>
  /** Sorted by stack index. */
  readonly openCells: readonly CellObj[]
  /**
   * Every task in id order once the program spawned one (or asked for `current_task()`), else null.
   * `stack`, `frames` and `openCells` above are the current task's.
   */
  readonly tasks: readonly Readonly<Task>[] | null
  /** The task executing the next step: 1 (the main script) while `tasks` is null. */
  readonly taskId: number
  protoById(id: number): FunctionProto
  /**
   * Executes exactly step `time` (requires status 'running'); `time` increases by 1 on success.
   * On a runtime error: status 'error', `error` set, `time` unchanged.
   */
  step(): void
  /** Steps while status is 'running' and `time < t`. */
  runUntil(t: number): void
  /**
   * Work done so far: steps plus the elements natives and operations allocated or visited within
   * single steps. It never decreases and only depends on the state (ARCHITECTURE §7.1.4).
   */
  readonly work: number
  snapshot(): VMSnapshot
  restore(snapshot: VMSnapshot): void
  /**
   * Tells the VM that a tool changed `object` in place (a what-if edit, §7.5), so the next snapshot
   * copies it rather than sharing an older copy.
   */
  noteEdit(object: HeapObject): void
}

/** Exported by vm.ts as `createVM`. The script closure gets id 1 and no alloc event. */
export type CreateVM = (program: Program, options: VMOptions) => VM

/** What `getLibrary()` returns (ARCHITECTURE §6.9). */
export interface Library {
  readonly source: string
  /** In BUILTIN_NAMES order: natives, then library closures (ids `-(index + 1)`). */
  readonly builtins: readonly Value[]
  /** Library protos, ids 0 .. protos.length - 1. */
  readonly protos: readonly FunctionProto[]
}

/** The runtime pieces the recorder needs (supplied by index.ts). */
export interface RuntimeDeps {
  readonly createVM: CreateVM
  readonly builtins: readonly Value[]
  readonly libraryProtos: readonly FunctionProto[]
}
