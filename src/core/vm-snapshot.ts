/**
 * Snapshots (ARCHITECTURE §6.8): deep copies of the whole VM record that preserve object identity
 * and ids. Strings, numbers, ranges, natives, library closures (negative ids) and protos are shared.
 * Copying is iterative (a work list), so nesting depth is unlimited.
 */
import type { RuntimeErrorInfo } from './api-types'
import type { Program } from './bytecode'
import { InternalError } from './diagnostics'
import type {
  CellObj,
  ClosureObj,
  Frame,
  HeapObject,
  IteratorObj,
  ListObj,
  RecordObj,
  Value,
  VMSnapshot,
  VMStatus,
} from './runtime-types'

/** The part of the VM state a snapshot captures. */
export interface MachineRecord {
  readonly stack: Value[]
  readonly frames: Frame[]
  readonly openCells: CellObj[]
  readonly globals: Map<string, Value>
  readonly time: number
  readonly nextObjectId: number
  readonly nextFrameUid: number
  readonly rngState: number
  readonly allocated: number
  readonly status: VMStatus
  readonly error: RuntimeErrorInfo | null
}

export class MachineSnapshot implements VMSnapshot {
  constructor(
    readonly time: number,
    readonly size: number,
    readonly program: Program,
    readonly record: MachineRecord,
  ) {}
}

/** A deep copy of `source` and the number of values copied. */
export function copyRecord(source: MachineRecord): { record: MachineRecord; size: number } {
  const copier = new GraphCopier()
  const stack = source.stack.map((value) => copier.value(value))
  const frames = source.frames.map((frame) => ({
    closure: copier.object(frame.closure),
    ip: frame.ip,
    base: frame.base,
    uid: frame.uid,
  }))
  const openCells = source.openCells.map((cell) => copier.object(cell))
  const globals = new Map<string, Value>()
  for (const [name, value] of source.globals) globals.set(name, copier.value(value))
  copier.drain()
  const record: MachineRecord = {
    stack,
    frames,
    openCells,
    globals,
    time: source.time,
    nextObjectId: source.nextObjectId,
    nextFrameUid: source.nextFrameUid,
    rngState: source.rngState,
    allocated: source.allocated,
    status: source.status,
    error: source.error,
  }
  return { record, size: copier.size + stack.length + frames.length + globals.size }
}

function isShared(object: HeapObject): boolean {
  return (
    object.type === 'range' ||
    object.type === 'native' ||
    (object.type === 'closure' && object.id < 0)
  )
}

class GraphCopier {
  /** Number of values copied into objects (one per object plus one per slot it holds). */
  size = 0
  private readonly copies = new Map<HeapObject, HeapObject>()
  /** Originals whose copies still need their contents. */
  private readonly pending: HeapObject[] = []

  value(value: Value): Value {
    return typeof value === 'object' && value !== null ? this.object(value) : value
  }

  /** The copy of `original`, created empty and queued for filling on first sight. */
  object<T extends HeapObject>(original: T): T {
    if (isShared(original)) return original
    const existing = this.copies.get(original)
    if (existing !== undefined) return existing as T
    const copy = this.shell(original)
    this.copies.set(original, copy)
    this.pending.push(original)
    return copy as T
  }

  drain(): void {
    while (this.pending.length > 0) {
      const original = this.pending.pop()!
      this.fill(original, this.copies.get(original)!)
    }
  }

  private shell(original: HeapObject): HeapObject {
    switch (original.type) {
      case 'list':
        return { type: 'list', id: original.id, items: original.items.slice() }
      case 'record':
        return { type: 'record', id: original.id, fields: new Map(original.fields) }
      case 'closure':
        return { type: 'closure', id: original.id, proto: original.proto, upvalues: [] }
      case 'cell':
        return { ...original }
      case 'iterator':
        return this.iteratorCopy(original)
      default:
        throw new InternalError(`cannot copy ${original.type}`)
    }
  }

  /** Iterators have no further mutable children; the source copy is queued like any value. */
  private iteratorCopy(original: IteratorObj): IteratorObj {
    return {
      type: 'iterator',
      id: original.id,
      source: this.value(original.source),
      position: original.position,
      keys: original.keys,
    }
  }

  private fill(original: HeapObject, copy: HeapObject): void {
    this.size += 1
    switch (original.type) {
      case 'list':
        this.fillList(copy as ListObj)
        break
      case 'record':
        this.fillRecord(copy as RecordObj)
        break
      case 'closure':
        this.fillClosure(original, copy as ClosureObj)
        break
      case 'cell':
        ;(copy as CellObj).value = this.value(original.value)
        this.size += 1
        break
      default:
        break
    }
  }

  /** The shell already holds the original items; replace object references with copies. */
  private fillList(copy: ListObj): void {
    const items = copy.items
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (typeof item === 'object' && item !== null) items[i] = this.object(item)
    }
    this.size += items.length
  }

  private fillRecord(copy: RecordObj): void {
    for (const [key, value] of copy.fields) {
      if (typeof value === 'object' && value !== null) copy.fields.set(key, this.object(value))
    }
    this.size += copy.fields.size
  }

  private fillClosure(original: ClosureObj, copy: ClosureObj): void {
    for (const cell of original.upvalues) copy.upvalues.push(this.object(cell))
    this.size += original.upvalues.length
  }
}
