/**
 * The instruction dispatch loop (ARCHITECTURE §5.2, §6.2–6.3). One switch over the hot opcodes
 * (locals, constants, arithmetic, comparisons, jumps, calls, returns, iteration); the rest are
 * delegated to `executeOther`. The current frame's code, constants and base live in locals and are
 * reloaded only when a call or return changes the frame.
 *
 * The loop is one long function on purpose: the recorder executes millions of steps, and splitting
 * the hot opcodes into separate functions measurably slows every step.
 */
import { Op, type FunctionProto } from './bytecode'
import { equals, isTruthy } from './values'
import type { ClosureObj, Frame, Value } from './runtime-types'
import {
  binaryOperandError,
  compareSlow,
  divideSlow,
  modulo,
  negateSlow,
  addSlow,
} from './vm-ops-arith'
import { callNonClosure, checkClosureCall, declareParameters } from './vm-calls'
import { VMFailure, buildErrorInfo, raise } from './vm-errors'
import { executeOther } from './vm-exec-other'
import { iterNext } from './vm-iter'
import type { MachineState } from './vm-state'

/** Runs instructions while the machine is running and `m.time < limit`. */
export function execute(m: MachineState, limit: number): void {
  if (m.status !== 'running' || m.time >= limit) return
  const stack = m.stack
  let frame: Frame = m.frames[m.frames.length - 1]!
  let proto: FunctionProto = frame.closure.proto
  let code = proto.code
  let constants = proto.constants
  let base = frame.base
  let ip = frame.ip
  let start = ip
  try {
    while (m.time < limit) {
      start = ip
      const op = code[ip++]!
      switch (op) {
        case Op.Const:
          stack.push(constants[code[ip++]!] as Value)
          break
        case Op.Nil:
          stack.push(null)
          break
        case Op.True:
          stack.push(true)
          break
        case Op.False:
          stack.push(false)
          break
        case Op.Pop:
          stack.pop()
          break
        case Op.GetLocal:
          stack.push(stack[base + code[ip++]!] as Value)
          break
        case Op.SetLocal: {
          const slot = code[ip++]!
          const value = stack.pop() as Value
          stack[base + slot] = value
          if (m.hooks !== null) m.recordLocal('write', frame.uid, slot, value)
          break
        }
        case Op.GetUpvalue: {
          const cell = frame.closure.upvalues[code[ip++]!]!
          stack.push(cell.open ? (stack[cell.stackIndex] as Value) : cell.value)
          break
        }
        case Op.SetUpvalue: {
          const cell = frame.closure.upvalues[code[ip++]!]!
          const value = stack.pop() as Value
          if (cell.open) stack[cell.stackIndex] = value
          else cell.value = value
          if (m.hooks !== null) m.recordCell(cell, value)
          break
        }
        case Op.GetGlobal: {
          const name = constants[code[ip++]!] as string
          const value = m.globals.get(name)
          if (value === undefined) raise('R006', `'${name}' was used before it was defined`)
          stack.push(value)
          break
        }
        case Op.GetBuiltin:
          stack.push(m.builtins[code[ip++]!] as Value)
          break
        case Op.Add: {
          const b = stack.pop() as Value
          const a = stack[stack.length - 1] as Value
          stack[stack.length - 1] =
            typeof a === 'number' && typeof b === 'number' ? a + b : addSlow(m, a, b)
          break
        }
        case Op.Sub: {
          const b = stack.pop() as Value
          const a = stack[stack.length - 1] as Value
          if (typeof a !== 'number' || typeof b !== 'number') binaryOperandError('-', a, b)
          stack[stack.length - 1] = a - b
          break
        }
        case Op.Mul: {
          const b = stack.pop() as Value
          const a = stack[stack.length - 1] as Value
          if (typeof a !== 'number' || typeof b !== 'number') binaryOperandError('*', a, b)
          stack[stack.length - 1] = a * b
          break
        }
        case Op.Div: {
          const b = stack.pop() as Value
          const a = stack[stack.length - 1] as Value
          stack[stack.length - 1] =
            typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : divideSlow(a, b)
          break
        }
        case Op.Mod: {
          const b = stack.pop() as Value
          stack[stack.length - 1] = modulo(stack[stack.length - 1] as Value, b)
          break
        }
        case Op.Neg: {
          const a = stack[stack.length - 1] as Value
          stack[stack.length - 1] = typeof a === 'number' ? -a : negateSlow(a)
          break
        }
        case Op.Not:
          stack[stack.length - 1] = !isTruthy(stack[stack.length - 1] as Value)
          break
        case Op.Eq: {
          const b = stack.pop() as Value
          stack[stack.length - 1] = equals(stack[stack.length - 1] as Value, b)
          break
        }
        case Op.Ne: {
          const b = stack.pop() as Value
          stack[stack.length - 1] = !equals(stack[stack.length - 1] as Value, b)
          break
        }
        case Op.Lt: {
          const b = stack.pop() as Value
          const a = stack[stack.length - 1] as Value
          stack[stack.length - 1] =
            typeof a === 'number' && typeof b === 'number' ? a < b : compareSlow('<', a, b)
          break
        }
        case Op.Le: {
          const b = stack.pop() as Value
          const a = stack[stack.length - 1] as Value
          stack[stack.length - 1] =
            typeof a === 'number' && typeof b === 'number' ? a <= b : compareSlow('<=', a, b)
          break
        }
        case Op.Gt: {
          const b = stack.pop() as Value
          const a = stack[stack.length - 1] as Value
          stack[stack.length - 1] =
            typeof a === 'number' && typeof b === 'number' ? a > b : compareSlow('>', a, b)
          break
        }
        case Op.Ge: {
          const b = stack.pop() as Value
          const a = stack[stack.length - 1] as Value
          stack[stack.length - 1] =
            typeof a === 'number' && typeof b === 'number' ? a >= b : compareSlow('>=', a, b)
          break
        }
        case Op.Jump:
          ip = code[ip]!
          break
        case Op.JumpIfFalse: {
          const target = code[ip++]!
          const condition = stack.pop() as Value
          if (condition === null || condition === false) ip = target
          break
        }
        case Op.AndJump: {
          const target = code[ip++]!
          const value = stack[stack.length - 1] as Value
          if (value === null || value === false) ip = target
          else stack.pop()
          break
        }
        case Op.OrJump: {
          const target = code[ip++]!
          const value = stack[stack.length - 1] as Value
          if (value === null || value === false) stack.pop()
          else ip = target
          break
        }
        case Op.IterNext: {
          const target = code[ip++]!
          if (!iterNext(m)) ip = target
          break
        }
        case Op.Call: {
          const argc = code[ip++]!
          const calleeIndex = stack.length - 1 - argc
          const callee = stack[calleeIndex] as Value
          if (!isClosure(callee)) {
            callNonClosure(m, callee, calleeIndex, argc)
            break
          }
          checkClosureCall(m, callee.proto, argc)
          frame.ip = ip
          frame = { closure: callee, ip: 0, base: calleeIndex, uid: m.nextFrameUid++ }
          m.frames.push(frame)
          proto = callee.proto
          code = proto.code
          constants = proto.constants
          base = calleeIndex
          ip = 0
          if (m.hooks !== null) declareParameters(m, frame, argc)
          break
        }
        case Op.Return: {
          const result = stack.pop() as Value
          m.closeCellsFrom(base)
          stack.length = base
          m.frames.pop()
          if (m.frames.length === 0) {
            frame.ip = ip
            m.status = 'finished'
            m.time++
            return
          }
          stack.push(result)
          frame = m.frames[m.frames.length - 1]!
          proto = frame.closure.proto
          code = proto.code
          constants = proto.constants
          base = frame.base
          ip = frame.ip
          break
        }
        default:
          ip = executeOther(m, frame, op, ip)
      }
      m.time++
    }
    frame.ip = ip
  } catch (caught) {
    if (!(caught instanceof VMFailure)) throw caught
    frame.ip = start
    m.status = 'error'
    m.error = buildErrorInfo(m.frames, caught, start, m.time)
  }
}

function isClosure(value: Value): value is ClosureObj {
  return typeof value === 'object' && value !== null && value.type === 'closure'
}
