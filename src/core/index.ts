/**
 * The public API of the core (ARCHITECTURE §8): the pipeline stages, fast runs, recordings and the
 * helpers tools need. The studio and the CLI import only this module.
 */
import {
  type AsyncRecordOptions,
  type CompileResult,
  DEFAULT_MAX_STEPS,
  DEFAULT_SEED,
  type Outcome,
  type OutputEvent,
  type RecordOptions,
  type Recording,
  type RunOptions,
  type RunResult,
} from './api-types'
import type { Program } from './bytecode'
import { compileProgram } from './compiler/index'
import { type Diagnostic, InternalError, compareDiagnostics } from './diagnostics'
import { getLibrary } from './library'
import { parse } from './parser'
import {
  type RepairOptions,
  type RepairRequest,
  type RepairSearch,
  repairSearch as repairSearchWith,
} from './repair'
import { record as recordWith, recordAsync as recordAsyncWith } from './recorder'
import { type InferOptions, type InferResult, inferContractsWith } from './infer'
import type { CallTree } from './calls'
import {
  type ByteCodec,
  decodeTraceFile,
  decodeTraceFileSync,
  type TraceBundle,
} from './trace-file'
import {
  openedTrace,
  replayTrace,
  replayTraceAsync,
  type TraceOpenResult,
  type TraceReplay,
  type TraceReplayOptions,
} from './trace-open'
import type { RuntimeDeps, VM, VMHooks } from './runtime-types'
import { createVM } from './vm'

export * from './api-types'
export type * from './diagnostics'
export { InternalError } from './diagnostics'
export type { LineCol, Span } from './span'
export { LineIndex } from './span'
export type * from './tokens'
export type { LexResult } from './lexer'
export { lex } from './lexer'
export type { ParseResult } from './parser'
export { parse } from './parser'
export type { FunctionProto, GlobalInfo, LocalInfo, LocalKind, Program } from './bytecode'
export type { Value } from './runtime-types'
export { disassemble } from './disasm'
export { verifyProgram } from './verify'
export { repr, show } from './values'
export { compareRecordings } from './compare'
export { formatLiteral, parseLiteralValue } from './literal'
export * from './calls'
export * from './bug-finder'
export * from './oracle'
export { contractKeywordStarts } from './contract-tokens'
export { answerAssertions, insertAssertions } from './answer-assertions'
export type { AnswerAssertion } from './answer-assertions'
export type { CallEffect, CallEffects } from './call-effects'
export { callEffects } from './call-effects'
export { eventsBetween } from './events'
export type { Dependence } from './dependence'
export { dependenceOf } from './dependence'
export * from './slice'
export * from './query'
export { QUERY_FUNCTIONS, QUERY_SPECIALS } from './query-eval'
export * from './why-not'
export * from './inverse'
export * from './sweep'
export * from './heap-diff'
export type {
  Repair,
  RepairExample,
  RepairOptions,
  RepairRequest,
  RepairResult,
  RepairSearch,
} from './repair'
export { repairExample, repairExamples } from './repair'
export * from './run-diff'
export type { MapMomentOptions, MappedMoment, MomentPrecision } from './run-map'
export { lineMap, mapMoment } from './run-map'
export type { InputResult } from './run-input'
export { withInput } from './run-input'
export * from './profile'
export type {
  ClauseText,
  ContractAddition,
  ContractSuggestion,
  FunctionContracts,
  InferOptions,
  InferResult,
  InsertedContracts,
  TemplateKind,
} from './infer'
export { clauseTexts, insertContracts, withContracts } from './infer'
export * from './trace-file'
export type { StepWindow, TraceCheckpoints, TraceFingerprint } from './trace-hash'
export { fingerprintRecording } from './trace-hash'
export type {
  AsyncTraceDeps,
  TraceBundleInput,
  TraceBundleResult,
  TraceDeps,
  TraceOpenResult,
  TraceReplay,
  TraceReplayErrorCode,
  TraceReplayOptions,
  TraceVerification,
} from './trace-open'
export { replayTrace, replayTraceAsync, traceBundle, verifyTrace } from './trace-open'

/** The prelude source (SPEC Appendix A). */
export function getLibrarySource(): string {
  return getLibrary().source
}

/** Runs the stages of SPEC §11.2 and returns the first failing stage's diagnostics. */
export function compile(source: string): CompileResult {
  const parsed = parse(source)
  if (parsed.diagnostics.length > 0) {
    return { ok: false, diagnostics: sortedUnique(parsed.diagnostics) }
  }
  const output = compileProgram(parsed.program, {
    source,
    mode: 'main',
    firstProtoId: getLibrary().protos.length,
  })
  if (output.program === null) {
    return { ok: false, diagnostics: sortedUnique(output.diagnostics) }
  }
  return { ok: true, program: output.program, diagnostics: [] }
}

function sortedUnique(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const sorted = [...diagnostics].sort(compareDiagnostics)
  return sorted.filter((d, i) => i === 0 || !sameDiagnostic(d, sorted[i - 1]!))
}

function sameDiagnostic(a: Diagnostic, b: Diagnostic): boolean {
  return (
    a.code === b.code &&
    a.message === b.message &&
    a.span.start === b.span.start &&
    a.span.end === b.span.end &&
    a.hint === b.hint
  )
}

/** The runtime pieces the recorder needs, from the shared library. */
function runtimeDeps(): RuntimeDeps {
  const library = getLibrary()
  return { createVM, builtins: library.builtins, libraryProtos: library.protos }
}

/** Runs a program without recording; only output is observed. */
export function run(program: Program, options: RunOptions = {}): RunResult {
  const maxSteps = stepLimit(options.maxSteps)
  const runtime = runtimeDeps()
  const vm = runtime.createVM(program, {
    builtins: runtime.builtins,
    libraryProtos: runtime.libraryProtos,
    seed: options.seed ?? DEFAULT_SEED,
  })
  const outputs: OutputEvent[] = []
  vm.hooks = outputHooks(outputs, options.onOutput)
  vm.runUntil(maxSteps)
  // Output emitted by a failing step is discarded, as the recorder does (ARCHITECTURE §7.1).
  const kept = outputs.filter((event) => event.time < vm.time)
  return { outputs: kept, outcome: outcomeOf(vm, maxSteps), steps: vm.time }
}

function stepLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_STEPS
  if (Number.isNaN(limit) || limit < 0) throw new InternalError(`invalid step limit ${limit}`)
  return Math.floor(limit)
}

function outcomeOf(vm: VM, maxSteps: number): Outcome {
  if (vm.status === 'finished') return { kind: 'finished' }
  if (vm.status === 'error') {
    if (vm.error === null) throw new InternalError('the VM failed without an error')
    return { kind: 'error', error: vm.error }
  }
  return { kind: 'step-limit', maxSteps }
}

function ignore(): void {}

function outputHooks(outputs: OutputEvent[], onOutput?: (text: string) => void): VMHooks {
  return {
    output(time, text) {
      outputs.push({ time, text })
      onOutput?.(text)
    },
    write: ignore,
    listOp: ignore,
    fieldDelete: ignore,
    alloc: ignore,
    cellClosed: ignore,
  }
}

/** Records a run for time travel. */
export function record(program: Program, options: RecordOptions = {}): Recording {
  return recordWith(program, runtimeDeps(), options)
}

/**
 * Searches for one-token repairs of the function a bug was isolated to (ARCHITECTURE §7.12); a
 * generator that yields after every mutant it has run.
 */
export function repairSearch(
  recording: Recording,
  request: RepairRequest,
  options: RepairOptions = {},
): RepairSearch {
  return repairSearchWith({ compile, record }, recording, request, options)
}

/**
 * Likely contracts for the functions of a recorded run (ARCHITECTURE §7.17), each checked by
 * recording the program again with the clauses written in.
 */
export function inferContracts(
  recording: Recording,
  tree: CallTree,
  options: InferOptions = {},
): InferResult {
  if (tree.recording !== recording) throw new InternalError('the call tree is of another recording')
  return inferContractsWith({ compile, record }, tree, options)
}

/** Records a run in slices, yielding to the host between them. */
export function recordAsync(
  program: Program,
  options: AsyncRecordOptions = {},
): Promise<Recording> {
  return recordAsyncWith(program, runtimeDeps(), options)
}

/**
 * Records a trace bundle's program again, re-applies its what-if edits and checks the run against
 * the saved fingerprint (ARCHITECTURE §7.15).
 */
export function openTraceBundle(bundle: TraceBundle): TraceReplay {
  return replayTrace({ compile, record }, bundle)
}

/** `openTraceBundle` in slices, abortable through `options.signal`. */
export function openTraceBundleAsync(
  bundle: TraceBundle,
  options: TraceReplayOptions = {},
): Promise<TraceReplay> {
  return replayTraceAsync({ compile, recordAsync }, bundle, options)
}

/** Decodes a `.sighttrace` file and opens it; a compressed file needs `gunzip`. */
export function openTraceFileSync(bytes: Uint8Array, gunzip?: ByteCodec | null): TraceOpenResult {
  const decoded = decodeTraceFileSync(bytes, gunzip)
  if (!decoded.ok) return { ok: false, code: 'format', error: decoded.error }
  return openedTrace(decoded.bundle, openTraceBundle(decoded.bundle))
}

/** Decodes a `.sighttrace` file (with the host's DecompressionStream) and opens it in slices. */
export async function openTraceFile(
  bytes: Uint8Array,
  options: TraceReplayOptions = {},
): Promise<TraceOpenResult> {
  const decoded = await decodeTraceFile(bytes)
  if (!decoded.ok) return { ok: false, code: 'format', error: decoded.error }
  return openedTrace(decoded.bundle, await openTraceBundleAsync(decoded.bundle, options))
}
