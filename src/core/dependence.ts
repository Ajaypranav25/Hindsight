/**
 * Dynamic dependence (ARCHITECTURE §7.8): for every recorded step, the earlier steps it depends
 * on. The event log says where values were *written*; this adds where they were *read*, by
 * replaying the run once beside a shadow of the VM that remembers, for every stack slot, variable,
 * record field and list element, the step that produced what it holds.
 *
 * A step depends on
 * - **data**: the steps that produced the operands it consumed and the variables, fields or
 *   elements it read (a native reads its arguments' contents; a `for` reads the element it binds
 *   and the list's shape);
 * - **control**: the latest branch decision (`if`, loop condition, `for` iteration, `match` arm,
 *   `and`/`or`) of its own call that decided whether it ran, else the call that started its frame.
 *
 * Following the edges backwards from a step gives its dynamic backward slice: everything that had
 * a causal path to it. Precision notes: values pass through `Dup`, block ends and call arguments
 * without a node of their own; reads of a whole object look two levels deep and at up to
 * `WHOLE_READ_LIMIT` parts of each level; a what-if edit starts a chain (it has no cause).
 */
import type { ForkEdit, Recording } from './api-types'
import { type FunctionProto, isPatternConst, Op } from './bytecode'
import { controlParents } from './dependence-control'
import { replayAccess } from './recorder'
import type { CellObj, Frame, HeapObject, Value, VM } from './runtime-types'
import { EventCode, ListOpCode, TargetCode } from './trace-columns'

/** Recordings longer than this are not analyzed (the graph would take too long to build). */
export const MAX_DEPENDENCE_STEPS = 4_000_000
/** The most parts of one object a whole-object read depends on, per level. */
export const WHOLE_READ_LIMIT = 64
const NONE = -1

export interface Dependence {
  /** N: steps `0..N` are nodes (N itself when the run stopped on an instruction). */
  readonly length: number
  /** The steps `t` depends on directly (do not mutate). */
  depsOf(t: number): Int32Array
  /** Marks (1) every step with a causal path to one of `criteria`, the criteria included. */
  slice(criteria: readonly number[]): Uint8Array
}

const cache = new WeakMap<Recording, Dependence | null>()

/** The dependence graph of `recording` (built on first use), or null when it cannot be built. */
export function dependenceOf(recording: Recording): Dependence | null {
  let graph = cache.get(recording)
  if (graph === undefined) {
    graph = recording.length > MAX_DEPENDENCE_STEPS ? null : build(recording)
    cache.set(recording, graph)
  }
  return graph
}

class Graph implements Dependence {
  constructor(
    readonly length: number,
    private readonly starts: Int32Array,
    private readonly edges: Int32Array,
  ) {}

  depsOf(t: number): Int32Array {
    return this.edges.subarray(this.starts[t]!, this.starts[t + 1]!)
  }

  slice(criteria: readonly number[]): Uint8Array {
    const marks = new Uint8Array(this.length + 1)
    const work: number[] = []
    for (const t of criteria) {
      if (Number.isInteger(t) && t >= 0 && t <= this.length && marks[t] === 0) {
        marks[t] = 1
        work.push(t)
      }
    }
    const { starts, edges } = this
    while (work.length > 0) {
      const t = work.pop()!
      for (let i = starts[t]!; i < starts[t + 1]!; i++) {
        const dep = edges[i]!
        if (marks[dep] === 0) {
          marks[dep] = 1
          work.push(dep)
        }
      }
    }
    return marks
  }
}

/** One frame's control state: the step that called it and its branches' latest decisions. */
interface Activation {
  readonly callStep: number
  readonly branches: Map<number, number>
}

function build(recording: Recording): Dependence | null {
  const access = replayAccess(recording)
  if (access === null) return null
  const { core } = access
  const length = core.length
  const last = core.end === null ? length - 1 : length
  const seeker = access.newSeeker()
  const { events, eventCount } = core

  const starts = new Int32Array(length + 2)
  let edges = new Int32Array(Math.max(1024, length * 3))
  let edgeCount = 0
  let stackDef = new Int32Array(1024).fill(NONE)
  const globalDef = new Map<string, number>()
  const cellDef = new Map<number, number>()
  const allocDef = new Map<number, number>()
  const shapeDef = new Map<number, number>()
  const fieldDefs = new Map<number, Map<string, number>>()
  const elemDefs = new Map<number, number[]>()
  const activations: Activation[] = []
  const edits = new Map<number, ForkEdit[]>()
  for (const { time, edit } of recording.whatIf?.edits ?? []) {
    edits.set(time, [...(edits.get(time) ?? []), edit])
  }

  const dep = (step: number | undefined): void => {
    if (step === undefined || step < 0) return
    if (edgeCount === edges.length) {
      const grown = new Int32Array(edges.length * 2)
      grown.set(edges)
      edges = grown
    }
    edges[edgeCount++] = step
  }
  const slot = (index: number): number => (index < stackDef.length ? stackDef[index]! : NONE)
  const setSlot = (index: number, step: number): void => {
    if (index >= stackDef.length) {
      const grown = new Int32Array(Math.max(stackDef.length * 2, index + 64)).fill(NONE)
      grown.set(stackDef)
      stackDef = grown
    }
    stackDef[index] = step
  }
  const fieldDef = (id: number, key: string): number =>
    fieldDefs.get(id)?.get(key) ?? allocDef.get(id) ?? NONE
  const elemDef = (id: number, index: number): number =>
    elemDefs.get(id)?.[index] ?? allocDef.get(id) ?? NONE
  const shapeOf = (id: number): number => shapeDef.get(id) ?? allocDef.get(id) ?? NONE
  const elemsOf = (id: number, upTo: number): number[] => {
    let defs = elemDefs.get(id)
    if (defs === undefined) {
      defs = []
      elemDefs.set(id, defs)
    }
    const filler = allocDef.get(id) ?? NONE
    while (defs.length < upTo) defs.push(filler)
    return defs
  }

  /** A read of everything in `value`: its fields or elements, two levels deep, bounded. */
  const wholeRead = (value: Value, levels: number): void => {
    if (value === null || typeof value !== 'object') return
    if (value.type === 'list') {
      dep(shapeOf(value.id))
      const defs = elemDefs.get(value.id)
      let previous = NONE
      const count = Math.min(value.items.length, WHOLE_READ_LIMIT)
      for (let i = 0; i < count; i++) {
        const def = defs?.[i] ?? NONE
        if (def !== previous) dep(def)
        previous = def
        if (levels > 0) wholeRead(value.items[i]!, levels - 1)
      }
      dep(allocDef.get(value.id))
    } else if (value.type === 'record') {
      let seen = 0
      for (const [key, item] of value.fields) {
        if (seen++ >= WHOLE_READ_LIMIT) break
        dep(fieldDef(value.id, key))
        if (levels > 0) wholeRead(item, levels - 1)
      }
      dep(allocDef.get(value.id))
    }
  }

  /** Cells over slots at or above `from` are about to close: they keep their slots' producers. */
  const closeCells = (cells: readonly CellObj[], from: number): void => {
    for (let i = cells.length - 1; i >= 0 && cells[i]!.stackIndex >= from; i--) {
      cellDef.set(cells[i]!.id, slot(cells[i]!.stackIndex))
    }
  }

  const applyEdit = (vm: VM, edit: ForkEdit): void => {
    const { target } = edit
    if (target.kind === 'global') globalDef.set(target.name, NONE)
    else if (target.kind === 'local') {
      const frame = vm.frames.find((candidate) => candidate.uid === target.frameUid)
      if (frame !== undefined) setSlot(frame.base + target.slot, NONE)
    } else if (target.kind === 'cell') {
      const cell = vm.openCells.find((candidate) => candidate.id === target.cellId)
      if (cell !== undefined) setSlot(cell.stackIndex, NONE)
      else cellDef.set(target.cellId, NONE)
    }
  }

  let row = 0
  let pendingLow = NONE
  let t = 0
  for (; t <= last; t++) {
    const vm = seeker.positionAt(t)
    const frames = vm.frames
    starts[t] = edgeCount
    if (frames.length === 0) break
    const frame = frames[frames.length - 1]!
    const stack = vm.stack
    const h = stack.length
    // The previous step's results sit above what it left untouched.
    if (pendingLow !== NONE) for (let i = pendingLow; i < h; i++) setSlot(i, t - 1)
    pendingLow = NONE
    for (const edit of edits.get(t) ?? []) applyEdit(vm, edit)

    // Control: the branch that let this instruction run, else the call that began the frame.
    while (activations.length > frames.length) activations.pop()
    while (activations.length < frames.length) {
      activations.push({ callStep: activations.length === 0 ? NONE : t - 1, branches: new Map() })
    }
    const activation = activations[activations.length - 1]!
    const proto = frame.closure.proto
    const ip = frame.ip
    const parent = controlParents(proto)[ip]!
    dep((parent === NONE ? undefined : activation.branches.get(parent)) ?? activation.callStep)

    pendingLow = dataDeps(t, vm, frame, proto, ip, h)

    if (t < length) {
      while (row < eventCount && events.times[row]! < t) row++
      for (; row < eventCount && events.times[row] === t; row++) heapEvent(row, t)
    }
  }
  starts.fill(edgeCount, t)
  return new Graph(length, starts, edges.subarray(0, edgeCount))

  /** Records the data reads of step `t` and returns the lowest slot its results will occupy. */
  function dataDeps(
    t: number,
    vm: VM,
    frame: Frame,
    proto: FunctionProto,
    ip: number,
    h: number,
  ): number {
    const stack = vm.stack
    const code = proto.code
    const base = frame.base
    const operands = (count: number): number => {
      for (let i = h - count; i < h; i++) dep(slot(i))
      return h - count
    }
    switch (code[ip]) {
      case Op.Pop:
        return h - 1
      case Op.PopN:
        closeCells(vm.openCells, h - code[ip + 1]!)
        return h - code[ip + 1]!
      case Op.EndScope: {
        const n = code[ip + 1]!
        closeCells(vm.openCells, h - 1 - n)
        setSlot(h - 1 - n, slot(h - 1))
        return NONE
      }
      case Op.Dup:
        setSlot(h, slot(h - 1))
        return NONE
      case Op.Dup2:
        setSlot(h, slot(h - 2))
        setSlot(h + 1, slot(h - 1))
        return NONE
      case Op.GetLocal:
        dep(slot(base + code[ip + 1]!))
        return h
      case Op.SetLocal:
        dep(slot(h - 1))
        setSlot(base + code[ip + 1]!, t)
        return h - 1
      case Op.GetUpvalue: {
        const cell = frame.closure.upvalues[code[ip + 1]!]
        if (cell !== undefined) dep(cell.open ? slot(cell.stackIndex) : cellDef.get(cell.id))
        return h
      }
      case Op.SetUpvalue: {
        dep(slot(h - 1))
        const cell = frame.closure.upvalues[code[ip + 1]!]
        if (cell?.open === true) setSlot(cell.stackIndex, t)
        else if (cell !== undefined) cellDef.set(cell.id, t)
        return h - 1
      }
      case Op.GetGlobal:
        dep(globalDef.get(proto.constants[code[ip + 1]!] as string))
        return h
      case Op.DefineGlobal:
      case Op.SetGlobal:
        dep(slot(h - 1))
        globalDef.set(proto.constants[code[ip + 1]!] as string, t)
        return h - 1
      case Op.Declare:
        for (let i = h - code[ip + 1]!; i < h; i++) {
          dep(slot(i))
          setSlot(i, t)
        }
        return NONE
      case Op.GetField: {
        const object = stack[h - 1]
        if (isObject(object) && object.type === 'record') {
          dep(fieldDef(object.id, proto.constants[code[ip + 1]!] as string))
        }
        return operands(1)
      }
      case Op.GetIndex: {
        const object = stack[h - 2]
        const index = stack[h - 1]
        if (isObject(object) && object.type === 'list' && typeof index === 'number') {
          dep(elemDef(object.id, index < 0 ? index + object.items.length : index))
        } else if (isObject(object) && object.type === 'record' && typeof index === 'string') {
          dep(fieldDef(object.id, index))
        }
        return operands(2)
      }
      case Op.SetField:
        return operands(2)
      case Op.SetIndex:
      case Op.RecordSet:
        return operands(3)
      case Op.Eq:
      case Op.Ne:
        wholeRead(stack[h - 2] ?? null, 1)
        wholeRead(stack[h - 1] ?? null, 1)
        return operands(2)
      case Op.Add:
      case Op.Sub:
      case Op.Mul:
      case Op.Div:
      case Op.Mod:
      case Op.Pow:
      case Op.Lt:
      case Op.Le:
      case Op.Gt:
      case Op.Ge:
      case Op.Range:
      case Op.ListAppend:
        return operands(2)
      case Op.ListExtend:
      case Op.RecordMerge:
        wholeRead(stack[h - 1] ?? null, 1)
        return operands(2)
      case Op.Neg:
      case Op.Not:
      case Op.IterInit:
        return operands(1)
      case Op.JumpIfFalse:
        activations[activations.length - 1]!.branches.set(ip, t)
        return operands(1)
      case Op.AndJump:
      case Op.OrJump:
        activations[activations.length - 1]!.branches.set(ip, t)
        dep(slot(h - 1))
        return h
      case Op.Call: {
        const argc = code[ip + 1]!
        const callee = stack[h - 1 - argc]
        dep(slot(h - 1 - argc))
        if (isObject(callee) && callee.type === 'closure') return h
        for (let i = h - argc; i < h; i++) wholeRead(stack[i] ?? null, 1)
        return operands(argc) - 1
      }
      case Op.Return:
        dep(slot(h - 1))
        closeCells(vm.openCells, base)
        return base
      case Op.List:
      case Op.Interp: {
        const n = code[ip + 1]!
        if (code[ip] === Op.Interp) for (let i = h - n; i < h; i++) wholeRead(stack[i] ?? null, 1)
        return operands(n)
      }
      case Op.Record:
        return operands(2 * code[ip + 1]!)
      case Op.IterNext: {
        activations[activations.length - 1]!.branches.set(ip, t)
        dep(slot(h - 1))
        const iterator = stack[h - 1]
        if (isObject(iterator) && iterator.type === 'iterator') {
          const source = iterator.source
          if (isObject(source) && source.type === 'list') {
            dep(shapeOf(source.id))
            dep(elemDef(source.id, iterator.position))
          } else if (isObject(source) && source.type === 'record') {
            const key = iterator.keys?.[iterator.position]
            if (key !== undefined) dep(fieldDef(source.id, key))
          }
        }
        return h
      }
      case Op.Destructure:
        wholeRead(stack[h - 1] ?? null, 1)
        return operands(1)
      case Op.MatchPattern: {
        activations[activations.length - 1]!.branches.set(ip, t)
        dep(slot(h - 1))
        const pattern = proto.constants[code[ip + 1]!]
        if (isPatternConst(pattern) && pattern.desc.t !== 'bind' && pattern.desc.t !== 'any') {
          wholeRead(stack[h - 1] ?? null, 1)
        }
        return h
      }
      case Op.NoMatch:
        dep(slot(h - 1))
        return h
      default:
        // Const, Nil, True, False, GetBuiltin, DefineBuiltin, Closure, Jump: nothing is read.
        return h
    }
  }

  /** A heap change of step `t` (event row `at`): the changed part is now produced by `t`. */
  function heapEvent(at: number, t: number): void {
    const kind = events.kinds[at]!
    const id = events.a[at]!
    if (kind === EventCode.alloc) {
      allocDef.set(id, t)
      return
    }
    const targetKind = events.targetKinds[at]!
    if (targetKind === TargetCode.field) {
      let fields = fieldDefs.get(id)
      if (fields === undefined) {
        fields = new Map()
        fieldDefs.set(id, fields)
      }
      fields.set(events.strings.text(events.b[at]!), t)
      return
    }
    if (targetKind === TargetCode.element) {
      const index = events.b[at]!
      elemsOf(id, index)[index] = t
      return
    }
    if (kind !== EventCode.list) return
    // The list's shape (its length, where things are) now also depends on this change.
    dep(shapeOf(id))
    shapeDef.set(id, t)
    const index = events.b[at]!
    switch (events.ops[at]) {
      case ListOpCode.append:
        elemsOf(id, index).push(t)
        break
      case ListOpCode.extend: {
        const defs = elemsOf(id, index)
        for (let i = 0; i < events.aux[at]!; i++) defs.push(t)
        break
      }
      case ListOpCode.insert:
        elemsOf(id, index).splice(index, 0, t)
        break
      case ListOpCode.remove: {
        const defs = elemDefs.get(id)
        if (defs !== undefined && index < defs.length) defs.splice(index, 1)
        break
      }
      default: {
        const defs = elemDefs.get(id)
        if (defs !== undefined && defs.length > index) defs.length = index
      }
    }
  }
}

function isObject(value: Value | undefined): value is HeapObject {
  return typeof value === 'object' && value !== null
}
