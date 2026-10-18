/**
 * Runtime contract between the VM, the natives, the library loader and the time-travel engine
 * (docs/ARCHITECTURE.md §6). The VM and natives mutate these objects internally; every other module
 * treats them as read-only.
 */
import type { ListOp, RuntimeErrorInfo, WriteTarget } from './api-types'
import type { FunctionProto, Program } from './bytecode'
import type { RuntimeErrorCode } from './diagnostics'

// ---------------------------------------------------------------------------------------------
// Values

/** nil is `null`; bools, numbers and strings are JS primitives. */
export type Value = null | boolean | number | string | HeapObject

export type HeapObject =
  ListObj | RecordObj | ClosureObj | NativeObj | RangeObj | IteratorObj | CellObj

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

/** An upvalue. Open: it aliases `stack[stackIndex]`. Closed: it holds `value`. */
export interface CellObj {
  readonly type: 'cell'
  readonly id: number
  open: boolean
  stackIndex: number
  value: Value
  /** The frame and slot the cell was created for (provenance aliasing, ARCHITECTURE §7.3). */
  readonly ownerFrameUid: number
  readonly slot: number
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
  /** The deterministic generator (SPEC §10.3). */
  random(): number
  seed(n: number): void
  /** Raises a runtime error at the current call. */
  fail(code: RuntimeErrorCode, message: string, hint?: string): never
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
  /** Number of values copied; drives the recorder's snapshot cadence. */
  readonly size: number
}

export type VMStatus = 'running' | 'finished' | 'error'

export interface VMOptions {
  /** In BUILTIN_NAMES order. */
  readonly builtins: readonly Value[]
  /** Library protos; their ids are 0 .. libraryProtos.length - 1. */
  readonly libraryProtos: readonly FunctionProto[]
  /** Default DEFAULT_SEED. */
  readonly seed?: number
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
  protoById(id: number): FunctionProto
  /**
   * Executes exactly step `time` (requires status 'running'); `time` increases by 1 on success.
   * On a runtime error: status 'error', `error` set, `time` unchanged.
   */
  step(): void
  /** Steps while status is 'running' and `time < t`. */
  runUntil(t: number): void
  snapshot(): VMSnapshot
  restore(snapshot: VMSnapshot): void
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
