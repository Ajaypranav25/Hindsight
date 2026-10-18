/**
 * Calls (SPEC §7.10, ARCHITECTURE §6.3) and closure creation. The step loop performs closure calls
 * inline; this module holds the checks, natives, and everything off the hot path.
 */
import { type FunctionProto, functionDisplayName } from './bytecode'
import { InternalError } from './diagnostics'
import type { Frame, NativeObj, Value } from './runtime-types'
import { articleType } from './values'
import { raise } from './vm-errors'
import type { MachineState } from './vm-state'

/** SPEC §10.5: active calls are user and library frames; the top-level frame does not count. */
export const MAX_ACTIVE_CALLS = 10_000

function argumentsText(count: number): string {
  return count === 1 ? '1 argument' : `${count} arguments`
}

/** R005 text for a native: `expects 1 argument`, `expects 1 to 3 arguments`, `expects at least …`. */
export function nativeArityMessage(native: NativeObj, got: number): string {
  const { minArgs: min, maxArgs: max } = native
  const expected =
    max === Infinity
      ? `at least ${argumentsText(min)}`
      : min === max
        ? argumentsText(min)
        : `${min} to ${max} arguments`
  return `'${native.name}' expects ${expected} but got ${got}`
}

/** R005 text for a user or library function; unnamed functions read `lambda expects …`. */
export function closureArityMessage(proto: FunctionProto, got: number): string {
  const name = proto.name === null ? functionDisplayName(proto) : `'${proto.name}'`
  return `${name} expects ${argumentsText(proto.arity)} but got ${got}`
}

/** Arity (R005) then depth (R016) for a closure call, before anything is mutated. */
export function checkClosureCall(m: MachineState, proto: FunctionProto, argc: number): void {
  if (proto.arity !== argc) raise('R005', closureArityMessage(proto, argc))
  if (m.frames.length > MAX_ACTIVE_CALLS) {
    raise('R016', `stack overflow: more than ${MAX_ACTIVE_CALLS} nested calls`)
  }
}

/** `declare` events for the parameter slots `1..argc` of a frame that was just entered. */
export function declareParameters(m: MachineState, frame: Frame, argc: number): void {
  const stack = m.stack
  for (let slot = 1; slot <= argc; slot++) {
    m.recordLocal('declare', frame.uid, slot, stack[frame.base + slot] as Value)
  }
}

/** `declare` events for `Declare n`: the top n slots of the current frame. */
export function declareTop(m: MachineState, frame: Frame, count: number): void {
  const stack = m.stack
  for (let i = stack.length - count; i < stack.length; i++) {
    m.recordLocal('declare', frame.uid, i - frame.base, stack[i] as Value)
  }
}

/** A call whose callee is not a closure: run a native atomically, or R004. */
export function callNonClosure(m: MachineState, callee: Value, calleeIndex: number, argc: number): void {
  if (typeof callee !== 'object' || callee === null || callee.type !== 'native') {
    raise('R004', `cannot call ${articleType(callee)}`)
  }
  if (argc < callee.minArgs || argc > callee.maxArgs) raise('R005', nativeArityMessage(callee, argc))
  const stack = m.stack
  const result = callee.fn(m.context, stack.slice(calleeIndex + 1))
  stack.length = calleeIndex
  stack.push(result)
}

/**
 * `Closure k (isLocal, index)…`: pushes the closure first, then captures, so a local function can
 * capture its own slot. Returns the code index after the capture pairs.
 */
export function createClosure(
  m: MachineState,
  proto: FunctionProto,
  code: readonly number[],
  ip: number,
  frame: Frame,
): number {
  const closure = m.newClosure(proto)
  m.stack.push(closure)
  const upvalues = closure.upvalues
  const enclosing = frame.closure.upvalues
  for (let i = 0; i < proto.upvalueCount; i++, ip += 2) {
    const index = code[ip + 1]!
    const cell = code[ip] === 1 ? m.captureLocal(frame, index) : enclosing[index]
    if (cell === undefined) throw new InternalError(`no upvalue ${index} to capture`)
    upvalues.push(cell)
  }
  return ip
}
