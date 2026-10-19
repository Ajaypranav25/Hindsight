/**
 * The opcodes the dispatch loop does not handle inline: scope management, globals, fields and
 * indexing, data literals, closures, iteration setup and patterns. None of them changes the
 * current frame.
 */
import { type FunctionProto, Op, type PatternConst } from './bytecode'
import { InternalError } from './diagnostics'
import type { Frame, Value } from './runtime-types'
import { createClosure, declareTop } from './vm-calls'
import { raise } from './vm-errors'
import { iterInit } from './vm-iter'
import { getField, getIndex, setField, setIndex } from './vm-ops-access'
import { binaryOperandError, makeRange } from './vm-ops-arith'
import {
  interpolate,
  listAppend,
  listExtend,
  listLiteral,
  recordLiteral,
  recordMerge,
  recordSet,
} from './vm-ops-data'
import { destructure, matchPattern, noMatch } from './vm-patterns'
import type { MachineState } from './vm-state'

/**
 * Executes `op`, whose operands start at `ip`, in `frame`. Returns the ip of the next instruction.
 */
export function executeOther(m: MachineState, frame: Frame, op: number, ip: number): number {
  const code = frame.closure.proto.code
  switch (op) {
    case Op.PopN:
      popN(m, code[ip]!)
      return ip + 1
    case Op.EndScope:
      endScope(m, code[ip]!)
      return ip + 1
    case Op.Dup:
      m.stack.push(m.stack[m.stack.length - 1] as Value)
      return ip
    case Op.Dup2: {
      const stack = m.stack
      stack.push(stack[stack.length - 2] as Value, stack[stack.length - 1] as Value)
      return ip
    }
    case Op.Declare:
      if (m.hooks !== null) declareTop(m, frame, code[ip]!)
      return ip + 1
    case Op.Pow:
      power(m)
      return ip
    case Op.Range:
      range(m, code[ip]! === 1)
      return ip + 1
    default:
      return executeNamed(m, frame, op, ip)
  }
}

/** Opcodes with a constant operand (names, patterns, protos) or a data-building effect. */
function executeNamed(m: MachineState, frame: Frame, op: number, ip: number): number {
  const proto = frame.closure.proto
  const code = proto.code
  switch (op) {
    case Op.SetGlobal:
      setGlobal(m, nameAt(proto, code[ip]!))
      return ip + 1
    case Op.DefineGlobal:
      defineGlobal(m, nameAt(proto, code[ip]!))
      return ip + 1
    case Op.DefineBuiltin:
      m.builtins[code[ip]!] = m.stack.pop() as Value
      return ip + 1
    case Op.GetField: {
      const stack = m.stack
      stack[stack.length - 1] = getField(stack[stack.length - 1] as Value, nameAt(proto, code[ip]!))
      return ip + 1
    }
    case Op.SetField: {
      const value = m.stack.pop() as Value
      setField(m, m.stack.pop() as Value, nameAt(proto, code[ip]!), value)
      return ip + 1
    }
    case Op.GetIndex: {
      const index = m.stack.pop() as Value
      const stack = m.stack
      stack[stack.length - 1] = getIndex(stack[stack.length - 1] as Value, index)
      return ip
    }
    case Op.SetIndex: {
      const value = m.stack.pop() as Value
      const index = m.stack.pop() as Value
      setIndex(m, m.stack.pop() as Value, index, value)
      return ip
    }
    case Op.Closure:
      return createClosure(m, protoAt(proto, code[ip]!), code, ip + 1, frame)
    default:
      return executeData(m, proto, op, ip)
  }
}

/** Literals, spreads, interpolation, iteration setup and patterns. */
function executeData(m: MachineState, proto: FunctionProto, op: number, ip: number): number {
  const code = proto.code
  switch (op) {
    case Op.List:
      listLiteral(m, code[ip]!)
      return ip + 1
    case Op.ListAppend:
      listAppend(m)
      return ip
    case Op.ListExtend:
      listExtend(m)
      return ip
    case Op.Record:
      recordLiteral(m, code[ip]!)
      return ip + 1
    case Op.RecordSet:
      recordSet(m)
      return ip
    case Op.RecordMerge:
      recordMerge(m)
      return ip
    case Op.Interp:
      interpolate(m, code[ip]!)
      return ip + 1
    case Op.IterInit:
      iterInit(m)
      return ip
    case Op.Destructure:
      destructure(m, patternAt(proto, code[ip]!))
      return ip + 1
    case Op.MatchPattern:
      return matchPattern(m, patternAt(proto, code[ip]!)) ? ip + 2 : code[ip + 1]!
    case Op.NoMatch:
      return noMatch(m)
    default:
      throw new InternalError(`invalid opcode ${op} in proto ${proto.id}`)
  }
}

/** `PopN n`: close cells for the top n slots, then pop them. */
function popN(m: MachineState, count: number): void {
  const newLength = m.stack.length - count
  m.closeCellsFrom(newLength)
  m.stack.length = newLength
}

/** `EndScope n`: `( x1…xn v -- v )`, closing cells for x1…xn. */
function endScope(m: MachineState, count: number): void {
  const stack = m.stack
  const kept = stack.pop() as Value
  const newLength = stack.length - count
  m.closeCellsFrom(newLength)
  stack.length = newLength
  stack.push(kept)
}

function power(m: MachineState): void {
  const stack = m.stack
  const b = stack.pop() as Value
  const a = stack[stack.length - 1] as Value
  if (typeof a !== 'number' || typeof b !== 'number') binaryOperandError('**', a, b)
  stack[stack.length - 1] = a ** b
}

function range(m: MachineState, inclusive: boolean): void {
  const stack = m.stack
  const b = stack.pop() as Value
  stack[stack.length - 1] = makeRange(m, stack[stack.length - 1] as Value, b, inclusive)
}

function setGlobal(m: MachineState, name: string): void {
  const value = m.stack.pop() as Value
  if (!m.globals.has(name)) raise('R006', `'${name}' was used before it was defined`)
  m.globals.set(name, value)
  m.recordGlobal('write', name, value)
}

function defineGlobal(m: MachineState, name: string): void {
  const value = m.stack.pop() as Value
  m.globals.set(name, value)
  m.recordGlobal('declare', name, value)
}

function nameAt(proto: FunctionProto, k: number): string {
  const name = proto.constants[k]
  if (typeof name !== 'string') throw new InternalError(`constant ${k} is not a name`)
  return name
}

function protoAt(proto: FunctionProto, k: number): FunctionProto {
  const constant = proto.constants[k]
  if (typeof constant !== 'object' || constant.tag !== 'proto') {
    throw new InternalError(`constant ${k} is not a function proto`)
  }
  return constant
}

function patternAt(proto: FunctionProto, k: number): PatternConst {
  const constant = proto.constants[k]
  if (typeof constant !== 'object' || constant.tag !== 'pattern') {
    throw new InternalError(`constant ${k} is not a pattern`)
  }
  return constant
}
