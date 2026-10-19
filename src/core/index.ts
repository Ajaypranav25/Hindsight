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
import { record as recordWith, recordAsync as recordAsyncWith } from './recorder'
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

/** Records a run in slices, yielding to the host between them. */
export function recordAsync(
  program: Program,
  options: AsyncRecordOptions = {},
): Promise<Recording> {
  return recordAsyncWith(program, runtimeDeps(), options)
}
