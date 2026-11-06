/**
 * What a call was given and what it gave back (ARCHITECTURE §7.6), read through the public
 * Recording API: the parameters at the call's entry, the value its `Return` left on the caller's
 * operand stack, the error it raised, and the arguments it changed (lists and records it mutated).
 */
import type { Recording, RuntimeErrorInfo, ValueView } from './api-types'
import type { FunctionProto, Program } from './bytecode'
import type { CallNode } from './calls'
import { cutText, deepText, keyText, PREVIEW_LENGTH, valueText } from './call-values'
import { InternalError } from './diagnostics'
import { LineIndex, type Span } from './span'

export interface CallValue {
  readonly value: ValueView
  /** As tools show values: primitives in `repr` form, objects by their preview. */
  readonly text: string
}

export interface CallArgument extends CallValue {
  /** The parameter's name; a pattern parameter is named by its pattern (`[a, b]`). */
  readonly name: string
  /** The argument's text after the call when the call changed it (a list or record); else null. */
  readonly after: string | null
}

export interface LineSpan {
  readonly start: number
  readonly end: number
}

export interface CallDetails {
  readonly call: CallNode
  /** The arguments at entry, in parameter order (none for the root). */
  readonly args: readonly CallArgument[]
  /** The returned value; null unless a function call returned. */
  readonly result: CallValue | null
  /** The run's error, for a call that raised it. */
  readonly error: RuntimeErrorInfo | null
  /** 1-based first and last line of the function in the main source; null for library code. */
  readonly lines: LineSpan | null
  /**
   * Equal for identical calls (the same function, argument values, changes to them and result);
   * null when that cannot be told, so the call is never taken for another.
   */
  readonly key: string | null
}

interface Parameter {
  readonly name: string
  readonly value: ValueView
}

const NIL: ValueView = { kind: 'nil' }
const KEY_SEPARATOR = '\u0000'
const lineIndexes = new WeakMap<Program, LineIndex>()

export function callDetails(recording: Recording, call: CallNode): CallDetails {
  const error = call.outcome === 'raised' ? runError(recording) : null
  const lines = linesOf(recording.program, call.protoId)
  if (call.depth === 0) return { call, args: [], result: null, error, lines, key: null }
  const after = call.outcome === 'returned' ? call.exit + 1 : recording.length
  const params = parameters(recording, call)
  const args = params.map((param) => argument(recording, call.entry, after, param))
  const result = call.outcome === 'returned' ? returnedValue(recording, call) : null
  const key = callKey(recording, call, params, after, result, error)
  return {
    call,
    args,
    result: result && { value: result, text: valueText(result) },
    error,
    lines,
    key,
  }
}

function runError(recording: Recording): RuntimeErrorInfo {
  if (recording.outcome.kind !== 'error') throw new InternalError('a call raised without an error')
  return recording.outcome.error
}

function mainProto(program: Program, protoId: number): FunctionProto | null {
  return program.protos[protoId - program.firstProtoId] ?? null
}

function linesOf(program: Program, protoId: number): LineSpan | null {
  const proto = mainProto(program, protoId)
  if (proto === null || proto.debug.source !== 'main') return null
  let index = lineIndexes.get(program)
  if (index === undefined) {
    index = new LineIndex(program.source)
    lineIndexes.set(program, index)
  }
  const span = proto.debug.span
  return { start: index.lineOf(span.start), end: index.lineOf(Math.max(span.start, span.end - 1)) }
}

/**
 * The callee's parameters at its first step. Identifier parameters are live locals there; a
 * pattern parameter lives in a hidden slot, so its value is read from the caller's operand stack
 * just before the call (callee, then the arguments, on top).
 */
function parameters(recording: Recording, call: CallNode): Parameter[] {
  const frame = recording.stateAt(call.entry).frames.at(-1)
  if (frame === undefined) throw new InternalError(`no frame at the entry of call ${call.id}`)
  const proto = mainProto(recording.program, call.protoId)
  const visible = frame.locals.filter((local) => local.kind === 'param')
  if (proto === null) return visible.map((local) => ({ name: local.name, value: local.value }))
  const bySlot = new Map(visible.map((local) => [local.slot, local.value]))
  let callerTemps: readonly ValueView[] | null = null
  return proto.debug.locals
    .filter((local) => local.kind === 'param' && local.startIp === 0 && local.slot <= proto.arity)
    .sort((a, b) => a.slot - b.slot)
    .map((local) => {
      const name = local.hidden ? sourceText(recording.program.source, local.declSpan) : local.name
      const value = bySlot.get(local.slot)
      if (value !== undefined) return { name, value }
      callerTemps ??= recording.stateAt(call.entry - 1).frames.at(-1)?.temps ?? []
      return { name, value: callerTemps[callerTemps.length - proto.arity + local.slot - 1] ?? NIL }
    })
}

function sourceText(source: string, span: Span): string {
  return source.slice(span.start, span.end)
}

function argument(
  recording: Recording,
  entry: number,
  after: number,
  param: Parameter,
): CallArgument {
  return {
    name: param.name,
    value: param.value,
    text: valueText(param.value),
    after: changedText(recording, entry, after, param.value),
  }
}

/** The text of a list or record argument after the call, when the call changed it. */
function changedText(
  recording: Recording,
  entry: number,
  after: number,
  value: ValueView,
): string | null {
  if (value.kind !== 'ref' || (value.type !== 'list' && value.type !== 'record')) return null
  const before = keyText(recording, entry, value)
  const later = keyText(recording, after, value)
  if (before === null || later === null || before === later) return null
  const shown = deepText(recording, after, value, 'display', PREVIEW_LENGTH)
  return shown === null ? null : cutText(shown.text, PREVIEW_LENGTH)
}

/**
 * The value the call returned: the caller's top operand right after the `Return` (or, should
 * that slot hold a local, the callee's top operand at its `Return`).
 */
function returnedValue(recording: Recording, call: CallNode): ValueView {
  const pushed = recording
    .stateAt(call.exit + 1)
    .frames.at(-1)
    ?.temps.at(-1)
  if (pushed !== undefined) return pushed
  const returning = recording.stateAt(call.exit).frames.at(-1)?.temps.at(-1)
  if (returning === undefined) throw new InternalError(`no return value for call ${call.id}`)
  return returning
}

function callKey(
  recording: Recording,
  call: CallNode,
  params: readonly Parameter[],
  after: number,
  result: ValueView | null,
  error: RuntimeErrorInfo | null,
): string | null {
  const ending = outcomeKey(recording, after, result, error)
  if (ending === null) return null
  const parts = [String(call.protoId)]
  for (const param of params) {
    const before = keyText(recording, call.entry, param.value)
    if (before === null) return null
    parts.push(before)
    if (param.value.kind === 'ref') {
      const later = laterKey(recording, after, param.value)
      if (later === null) return null
      parts.push(later)
    }
  }
  parts.push(ending)
  return parts.join(KEY_SEPARATOR)
}

/** An argument object's text after the call; empty once nothing can reach it any more. */
function laterKey(recording: Recording, after: number, value: ValueView): string | null {
  const text = keyText(recording, after, value)
  if (text !== null || value.kind !== 'ref') return text
  return recording.objectAt(after, value.id, { offset: 0, limit: 1 }) === null ? '' : null
}

function outcomeKey(
  recording: Recording,
  after: number,
  result: ValueView | null,
  error: RuntimeErrorInfo | null,
): string | null {
  if (error !== null) return `raised ${error.code} ${error.message}`
  if (result === null) return null
  const text = keyText(recording, after, result)
  return text === null ? null : `returned ${text}`
}
