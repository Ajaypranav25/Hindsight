/**
 * The mutable VM record (ARCHITECTURE §6.2) with the primitives every operation shares: allocation
 * with ids and `alloc` events, cells, list/record mutations with their events, and the generator.
 *
 * Event helpers take primitive arguments and build the event target only when hooks are attached,
 * so running without hooks allocates nothing extra. Hooks never influence the state.
 */
import type { ListOp, RuntimeErrorInfo } from './api-types'
import { DEFAULT_SEED } from './api-types'
import type { FunctionProto, Program } from './bytecode'
import { InternalError } from './diagnostics'
import type {
  CellObj,
  ClosureObj,
  Frame,
  HeapObject,
  IteratorObj,
  ListObj,
  NativeContext,
  RangeObj,
  RecordObj,
  Value,
  VMHooks,
  VMOptions,
  VMStatus,
} from './runtime-types'
import { MEMORY_LIMIT } from './values-guards'
import { MachineContext } from './vm-context'
import { MEMORY_LIMIT_EXCEEDED, raise } from './vm-errors'

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
  /** Scratch buffer for pattern bindings, reused to keep matching allocation-free. */
  readonly bindings: Binding[] = []

  constructor(program: Program, options: VMOptions) {
    this.program = program
    // Deliberately not copied: see `builtins` above.
    this.builtins = options.builtins as Value[]
    this.libraryProtos = options.libraryProtos
    this.rngState = (options.seed ?? DEFAULT_SEED) >>> 0
    const script: ClosureObj = { type: 'closure', id: 1, proto: program.script, upvalues: [] }
    this.stack = [script]
    this.frames = [{ closure: script, ip: 0, base: 0, uid: 1 }]
    this.context = new MachineContext(this)
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
    this.recordListOp(list.id, 'append', index, 1, value)
  }

  insertItem(list: ListObj, index: number, value: Value): void {
    if (!(index >= 0 && index <= list.items.length)) throw new InternalError('insert out of range')
    this.charge(1)
    list.items.splice(index, 0, value)
    this.recordListOp(list.id, 'insert', index, 1, value)
  }

  removeItem(list: ListObj, index: number): Value {
    if (!(index >= 0 && index < list.items.length)) throw new InternalError('remove out of range')
    const removed = list.items.splice(index, 1)[0] as Value
    this.recordListOp(list.id, 'remove', index, 1, removed)
    return removed
  }

  popItem(list: ListObj): Value {
    if (list.items.length === 0) throw new InternalError('pop from an empty list')
    const removed = list.items.pop() as Value
    this.recordListOp(list.id, 'pop', list.items.length, 1, removed)
    return removed
  }

  deleteField(record: RecordObj, key: string): Value {
    const old = record.fields.get(key)
    if (old === undefined) return null
    record.fields.delete(key)
    if (this.hooks !== null) this.hooks.fieldDelete(this.time, record.id, key)
    return old
  }

  // -------------------------------------------------------------------------------------------
  // The generator (SPEC §10.3): mulberry32 over a uint32 state.

  nextRandom(): number {
    const state = (this.rngState + 0x6d2b79f5) >>> 0
    this.rngState = state
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  reseed(seed: number): void {
    this.rngState = seed >>> 0
  }
}
