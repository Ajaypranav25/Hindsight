/**
 * Dynamic backward slices (ARCHITECTURE §7.8): the steps, source lines and upstream writes with a
 * causal path to a moment of the run, read from the dependence graph. Fault localization dims the
 * lines outside the slice of a crash; the inverse what-if looks for its candidates among the
 * slice's writes.
 */
import type { ProvenanceEvent, Recording } from './api-types'
import { type FunctionProto, instructionLength, Op } from './bytecode'
import { dependenceOf } from './dependence'
import { eventsBetween } from './events'
import { replayAccess } from './recorder'

export interface Slice {
  /** The steps the slice was taken from. */
  readonly criteria: readonly number[]
  /** Per step `0..N`: 1 when the step is in the slice (do not mutate). */
  readonly marks: Uint8Array
  /** Number of steps in the slice. */
  readonly steps: number
  /** 1-based lines of the main source with a step in the slice. */
  readonly lines: ReadonlySet<number>
}

/** The slice of one step or several; null when the recording cannot be analyzed. */
export function backwardSlice(
  recording: Recording,
  criteria: number | readonly number[],
): Slice | null {
  const graph = dependenceOf(recording)
  const access = replayAccess(recording)
  if (graph === null || access === null) return null
  const list = typeof criteria === 'number' ? [criteria] : [...criteria]
  const marks = graph.slice(list)
  const { steps, end, length } = access.core
  const lines = new Set<number>()
  const seen = new Set<number>()
  let count = 0
  const add = (protoId: number, ip: number): void => {
    const key = protoId * 0x100000 + ip
    if (seen.has(key)) return
    seen.add(key)
    const proto = access.table.proto(protoId)
    if (proto.debug.source !== 'main') return
    lines.add(access.table.lineOf(proto, proto.debug.spanStart[ip] ?? 0))
    lines.add(access.table.stmtLines(proto)[ip]!)
  }
  for (let t = 0; t < length; t++) {
    if (marks[t] === 0) continue
    count += 1
    add(steps.protoIds[t]!, steps.ips[t]!)
  }
  if (marks[length] === 1 && end !== null) {
    count += 1
    add(end.protoId, end.ip)
  }
  return { criteria: list, marks, steps: count, lines }
}

/** The slice of the instruction a failed run stopped on; null for runs that did not fail. */
export function errorSlice(recording: Recording): Slice | null {
  if (recording.outcome.kind !== 'error') return null
  return backwardSlice(recording, recording.length)
}

/** A write in a slice: a variable, field or element got a value some later step depended on. */
export interface UpstreamWrite {
  readonly event: ProvenanceEvent
  /** The variable's name, `.field` or `[index]`; null when it has none (a temporary). */
  readonly name: string | null
  /** The line of the main source that performed it, or null (library code). */
  readonly line: number | null
}

/** The most events `upstreamWrites` reads. */
export const UPSTREAM_EVENT_LIMIT = 200_000

/**
 * The declarations and writes performed by steps of `slice`, in time order: the values the
 * criterion was computed from. Parameters count when their call is in the slice.
 */
export function upstreamWrites(recording: Recording, slice: Slice): UpstreamWrite[] {
  const access = replayAccess(recording)
  if (access === null) return []
  const { events } = eventsBetween(recording, 0, recording.length, UPSTREAM_EVENT_LIMIT)
  const writes: UpstreamWrite[] = []
  for (const event of events) {
    if (slice.marks[event.time] !== 1) continue
    if (event.kind !== 'declare' && event.kind !== 'write') continue
    const location = recording.locationAt(event.time)
    writes.push({
      event,
      name: writeName(recording, event),
      line: location !== null && location.source === 'main' ? location.line : null,
    })
  }
  return writes
}

/** The name a write's target goes by in the source, when it has one. */
export function writeName(recording: Recording, event: ProvenanceEvent): string | null {
  const { target } = event
  switch (target.kind) {
    case 'global':
      return target.name
    case 'field':
      return `.${target.key}`
    case 'element':
      return `[${target.index}]`
    case 'object':
      return null
    default:
      return variableName(recording, event.time, target.kind === 'local' ? target.slot : null)
  }
}

function variableName(recording: Recording, time: number, slot: number | null): string | null {
  const access = replayAccess(recording)
  if (access === null || time >= recording.length) return null
  const { steps } = access.core
  const proto = access.table.proto(steps.protoIds[time]!)
  const ip = steps.ips[time]!
  const op = proto.code[ip]
  if (op === Op.SetUpvalue) return proto.debug.upvalueNames[proto.code[ip + 1]!] ?? null
  if (slot === null) return null
  if (op === Op.Call) {
    // A parameter is declared by the call: its name is the callee's.
    if (time + 1 >= recording.length || steps.depths[time + 1]! <= steps.depths[time]!) return null
    const callee = access.table.proto(steps.protoIds[time + 1]!)
    return localAt(callee, slot, 0)
  }
  return localAt(proto, slot, ip + instructionLength(proto.code, ip, proto.constants))
}

/** The visible local in `slot` that is live at `ip` (the innermost when several share the slot). */
function localAt(proto: FunctionProto, slot: number, ip: number): string | null {
  let found: { readonly name: string; readonly startIp: number } | null = null
  for (const local of proto.debug.locals) {
    if (local.slot !== slot || local.hidden || local.startIp > ip || local.endIp <= ip) continue
    if (found === null || local.startIp > found.startIp) found = local
  }
  return found?.name ?? null
}
