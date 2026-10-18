/**
 * Runtime failures inside the VM (ARCHITECTURE §6.6): the internal exception that carries a runtime
 * error from the failing operation to the step loop, and the `RuntimeErrorInfo` built from it.
 */
import type { RuntimeErrorInfo, StackEntry } from './api-types'
import { functionDisplayName, type FunctionProto } from './bytecode'
import type { RuntimeErrorCode } from './diagnostics'
import type { Span } from './span'
import type { Frame } from './runtime-types'

/**
 * Thrown by operations and natives (through `NativeContext.fail`) and caught by the step loop,
 * which turns it into a `RuntimeErrorInfo`. Never escapes the VM.
 */
export class VMFailure extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly hint: string | undefined,
  ) {
    super(message)
    this.name = 'VMFailure'
  }
}

export function raise(code: RuntimeErrorCode, message: string, hint?: string): never {
  throw new VMFailure(code, message, hint)
}

export const RESULT_TOO_LARGE = 'result too large'

export function raiseTooLarge(): never {
  return raise('R025', RESULT_TOO_LARGE)
}

/** The debug span of code index `ip` in `proto` (operand indices repeat their instruction's span). */
export function spanAt(proto: FunctionProto, ip: number): Span {
  const debug = proto.debug
  return { start: debug.spanStart[ip] ?? 0, end: debug.spanEnd[ip] ?? 0 }
}

/**
 * The error as reported (SPEC §10.4): the failing instruction's span, or, when it belongs to library
 * code, the span of the `Call` that the nearest user frame is waiting on. The stack lists every frame
 * innermost first; callers show the call they wait on (the code index just before their ip).
 */
export function buildErrorInfo(
  frames: readonly Frame[],
  failure: VMFailure,
  failingIp: number,
  time: number,
): RuntimeErrorInfo {
  const stack: StackEntry[] = []
  let userSpan: Span | null = null
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]!
    const proto = frame.closure.proto
    const span = spanAt(proto, i === frames.length - 1 ? failingIp : frame.ip - 1)
    const library = proto.debug.library
    if (!library && userSpan === null) userSpan = span
    stack.push({ name: functionDisplayName(proto), span, library })
  }
  const span = userSpan ?? stack[0]?.span ?? { start: 0, end: 0 }
  const info = { code: failure.code, message: failure.message, span, stack, time }
  return failure.hint === undefined ? info : { ...info, hint: failure.hint }
}
