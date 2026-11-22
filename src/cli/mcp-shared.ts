/**
 * What the MCP tools share (ARCHITECTURE §9.1): JSON types, the tool shape, argument readers that
 * turn bad input into tool errors, and the JSON forms of values, outcomes and events.
 */
import {
  type CallDetails,
  callSignature,
  changeTexts,
  formatLiteral,
  LineIndex,
  outcomeText,
  type ProvenanceEvent,
  type Recording,
  type TaskWaitView,
  type TracedValue,
  type UnfinishedTask,
  type ValueView,
  writeName,
} from '../core/index'

export type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json }
export type JsonObject = { readonly [key: string]: Json }
export type Args = Readonly<Record<string, unknown>>

export interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Json
  run(args: Args): Json
}

/** A problem with a tool call that the agent can fix: reported as a tool error, not a crash. */
export class ToolError extends Error {}

export interface Trace {
  readonly id: string
  readonly source: string
  readonly recording: Recording
  /** The trace this one was forked from. */
  readonly parent: string | null
  /**
   * The real run behind a what-if (its step limit goes into a saved trace), kept with the trace
   * because its own trace may already have been dropped; null for a real run.
   */
  readonly base: Recording | null
}

/** A program recorded as a new trace, or why it could not be (compile errors, as JSON). */
export type RecordedSource =
  | { readonly ok: true; readonly trace: Trace }
  | { readonly ok: false; readonly failure: JsonObject }

/** What tools need from the server: the trace store and the shared argument checks. */
export interface ToolContext {
  /** The server's version, stored in exported trace files. */
  readonly version: string
  /** The trace named by `args[key]` (default `trace_id`). */
  trace(args: Args, key?: string): Trace
  /** A step of `trace` from `args[key]` (default `step`): an integer in 0..steps. */
  step(args: Args, trace: Trace, key?: string): number
  /** Stores a recording as a new trace (`base`: the real run behind a what-if). */
  keep(source: string, recording: Recording, parent: string | null, base?: Recording | null): Trace
  /** Compiles and records `source` with `args.max_steps` and `args.seed` as a new trace. */
  recordSource(source: unknown, args: Args): RecordedSource
  /**
   * The trace named by `args[traceKey]`, or a new one recorded from `args[sourceKey]`; compile
   * errors become a tool error listing them.
   */
  traceOrSource(args: Args, traceKey: string, sourceKey: string): Trace
}

export const MAX_SOURCE_LENGTH = 200_000
export const MAX_STEPS_CAP = 10_000_000

export const TRACE_ID = {
  type: 'string',
  description: 'A trace id returned by run_trace, fork_whatif or diff_runs',
} as const
export const STEP = {
  type: 'integer',
  minimum: 0,
  description: 'A step (time) of the trace, 0..steps; the state before that instruction runs',
} as const
export const SOURCE = {
  type: 'string',
  description: 'A Hindsight program (.sight text); recorded as a new trace',
} as const
export const MAX_STEPS = {
  type: 'integer',
  minimum: 1,
  description: 'Step limit when recording a source (default 2,000,000)',
} as const
export const SEED = {
  type: 'integer',
  description: 'Seed of the random generator when recording a source (default 42)',
} as const

export function schema(properties: Record<string, Json>, required: readonly string[]): Json {
  return { type: 'object', properties, required: [...required], additionalProperties: false }
}

/** An optional integer argument in `min..max`; out of range is a tool error. */
export function integerArg(
  args: Args,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`${key} must be an integer from ${min} to ${max}`)
  }
  return value
}

/** An optional integer argument clamped into `min..max` (for limits: too big means "all"). */
export function clampedArg(
  args: Args,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolError(`${key} must be a number`)
  }
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function booleanArg(args: Args, key: string, fallback: boolean): boolean {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new ToolError(`${key} must be true or false`)
  return value
}

export function stringArg(args: Args, key: string): string | null {
  const value = args[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new ToolError(`${key} must be a string`)
  return value
}

/** One of `choices`, or `fallback` when absent. */
export function choiceArg<T extends string>(
  args: Args,
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) {
    throw new ToolError(`${key} must be one of: ${choices.join(', ')}`)
  }
  return value as T
}

// --- JSON forms ---------------------------------------------------------------------------------

export function valueJson(value: ValueView): Json {
  switch (value.kind) {
    case 'nil':
      return null
    case 'bool':
    case 'number':
    case 'string':
      return value.value
    case 'ref':
      return { object: value.id, type: value.type, preview: value.preview }
  }
}

export function tracedJson(value: TracedValue): Json {
  return value !== null && typeof value === 'object' ? { object: value.ref } : value
}

export function outcomeJson(recording: Recording): Json {
  const { outcome } = recording
  if (outcome.kind === 'finished' && outcome.unfinishedTasks !== undefined) {
    return { kind: 'finished', unfinished_tasks: unfinishedJson(outcome.unfinishedTasks) }
  }
  if (outcome.kind !== 'error') return { kind: outcome.kind }
  const { error } = outcome
  const line = new LineIndex(recording.program.source).lineOf(error.span.start)
  return { kind: 'error', code: error.code, message: error.message, hint: error.hint ?? null, line }
}

/** What a blocked task waits for (SPEC §10.6), or null. */
export function waitJson(wait: TaskWaitView | null): Json {
  if (wait === null) return null
  return wait.kind === 'join'
    ? { waits_for: 'task', task: wait.task }
    : { waits_for: wait.kind, channel: wait.channelId }
}

/** The tasks a finished run left unfinished, for outcomes. */
function unfinishedJson(tasks: readonly UnfinishedTask[]): Json {
  return tasks.map((task) => ({
    task: task.id,
    name: task.name,
    status: task.status,
    wait: waitJson(task.wait),
  }))
}

/** The user-code line of the instruction at `time`, or null (library code, the end). */
export function lineOf(recording: Recording, time: number): number | null {
  const location = recording.locationAt(Math.min(Math.max(0, time), recording.length))
  return location !== null && location.source === 'main' ? location.line : null
}

export function eventJson(recording: Recording, event: ProvenanceEvent): Json {
  return {
    step: event.time,
    line: lineOf(recording, event.time),
    kind: event.kind,
    name: writeName(recording, event),
    value: tracedJson(event.value),
  }
}

/** A recorded call as the bug finder shows it. */
export function callJson(details: CallDetails): JsonObject {
  const { call } = details
  return {
    call: callSignature(details),
    function: call.depth === 0 ? '<top level>' : call.name,
    arguments: details.args.map((arg) => ({ name: arg.name, value: arg.text })),
    result: outcomeText(details),
    side_effects: changeTexts(details),
    lines: details.lines === null ? null : { start: details.lines.start, end: details.lines.end },
    first_step: call.entry,
  }
}

/** The text of `line` in `source` (1-based), or null when there is no such line. */
export function sourceLine(source: string, line: number | null): string | null {
  if (line === null) return null
  const index = new LineIndex(source)
  return line >= 1 && line <= index.lineCount ? index.lineText(line) : null
}

/** A page of `items`: the slice, the total and where the next page starts (null at the end). */
export function page<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): { readonly items: readonly T[]; readonly total: number; readonly next: number | null } {
  const shown = items.slice(offset, offset + limit)
  const end = offset + shown.length
  return { items: shown, total: items.length, next: end < items.length ? end : null }
}

/** The most values `jsonLiteral` converts in one call. */
export const MAX_LITERAL_VALUES = 10_000

type LiteralTask = { readonly text: string } | { readonly value: unknown }

/**
 * A JSON value as Hindsight literal text: arrays become lists, objects records (string keys),
 * null `nil`. Built with an explicit work stack; non-finite numbers and oversized values are
 * tool errors naming `what`.
 */
export function jsonLiteral(root: unknown, what: string): string {
  let out = ''
  let values = 0
  const work: LiteralTask[] = [{ value: root }]
  while (work.length > 0) {
    const task = work.pop()!
    if ('text' in task) {
      out += task.text
      continue
    }
    if (++values > MAX_LITERAL_VALUES) throw new ToolError(`${what} is too large`)
    const { value } = task
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      out += formatLiteral(value)
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new ToolError(`${what} must use finite numbers`)
      out += formatLiteral(value)
    } else if (Array.isArray(value)) {
      work.push({ text: ']' })
      for (let i = value.length - 1; i >= 0; i--) {
        work.push({ value: value[i] })
        if (i > 0) work.push({ text: ', ' })
      }
      work.push({ text: '[' })
    } else if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      work.push({ text: '}' })
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, item] = entries[i]!
        work.push({ value: item })
        work.push({ text: `${formatLiteral(key)}: ` })
        if (i > 0) work.push({ text: ', ' })
      }
      work.push({ text: '{' })
    } else {
      throw new ToolError(`${what} must be a JSON value or literal text`)
    }
  }
  return out
}
