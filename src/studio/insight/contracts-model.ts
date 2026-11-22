/**
 * "Suggest contracts" (ARCHITECTURE §11.3): which function a request is about, and the texts the
 * suggestions card shows. Pure functions over the recorded program and the inference result.
 */
import {
  type ContractSuggestion,
  type FunctionContracts,
  type InferResult,
  LineIndex,
  type Program,
  type Recording,
} from '../../core/index'
import { formatCount } from '../lib/format'

/** A named `fn` of the shown run whose contracts can be inferred. */
export interface ContractsTarget {
  readonly name: string
  /** Its proto's `debug.span.start`: where `insertContracts` finds it. */
  readonly functionStart: number
  /** The line its `fn` starts on. */
  readonly line: number
  /** The run the suggestions are inferred from. */
  readonly recording: Recording
}

/** The user functions of `program` that have names, by the line their definition starts on. */
function namedFunctions(program: Program): { proto: Program['protos'][number]; line: number }[] {
  const lines = new LineIndex(program.source)
  // Stand-in recordings in tests may come without a proto table.
  const protos = program.protos ?? []
  return protos
    .filter((proto) => proto.debug.source === 'main' && proto.kind === 'function')
    .filter((proto) => proto.name !== null)
    .map((proto) => ({ proto, line: lines.lineOf(proto.debug.span.start) }))
}

/** The named function whose definition starts on `line` of the recorded program, or null. */
export function functionAtLine(recording: Recording, line: number): ContractsTarget | null {
  const found = namedFunctions(recording.program).find((entry) => entry.line === line)
  if (found === undefined) return null
  return {
    name: found.proto.name!,
    functionStart: found.proto.debug.span.start,
    line: found.line,
    recording,
  }
}

/** The named user function with proto `protoId` (a frame of the call stack), or null. */
export function functionOfProto(recording: Recording, protoId: number): ContractsTarget | null {
  const found = namedFunctions(recording.program).find((entry) => entry.proto.id === protoId)
  if (found === undefined) return null
  return {
    name: found.proto.name!,
    functionStart: found.proto.debug.span.start,
    line: found.line,
    recording,
  }
}

/** The inference result's entry for the target's function. */
export function contractsFor(
  result: InferResult,
  target: ContractsTarget,
): FunctionContracts | null {
  return result.functions.find((f) => f.functionStart === target.functionStart) ?? null
}

/** `held in 12 calls with 5 different inputs`. */
export function supportText(suggestion: ContractSuggestion): string {
  const { calls, inputs } = suggestion.support
  const callWord = calls === 1 ? 'call' : 'calls'
  const inputWord = inputs === 1 ? 'input' : 'inputs'
  return `held in ${formatCount(calls)} ${callWord} with ${formatCount(inputs)} different ${inputWord}`
}

/** What the card says above (or instead of) the clauses. */
export function contractsSummary(found: FunctionContracts | null, result: InferResult): string {
  if (found === null) return 'This function did not take part in the run.'
  if (found.suggestions.length === 0) {
    return `No contracts to suggest: ${found.name} ${found.note ?? 'gave nothing to go on'}.`
  }
  const calls = `${formatCount(found.calls)} ${found.calls === 1 ? 'call' : 'calls'}`
  const sampled = found.sampled < found.calls ? `; ${formatCount(found.sampled)} were read` : ''
  const checked = result.verified
    ? ', and the clauses checked by recording the program with them'
    : ''
  return `What every one of its ${calls} did${sampled}${checked}.`
}
