/**
 * The conformance checker (docs/ARCHITECTURE.md §10.2): runs one annotated `.sight` source through
 * the public API and reports every way the result disagrees with the file's annotations. Shared by
 * tests/corpus.test.ts and `hindsight test`.
 */
import type {
  CompileResult,
  OutputEvent,
  RecordOptions,
  RunOptions,
  RunResult,
} from '../core/api-types'
import type { Program } from '../core/bytecode'
import type { Diagnostic } from '../core/diagnostics'
import { LineIndex } from '../core/span'
import type { Annotation, ErrorAnnotation } from './annotations'
import { parseAnnotations } from './annotations'
import { compareRunWithRecording, type RecordingSummary } from './compare-recording'
import { describeReported, matchesAnnotation, type ReportedError } from './reported'

export const CONFORMANCE_MAX_STEPS = 5_000_000
export const CONFORMANCE_SEED = 42

export type { RecordingSummary }

/** The slice of the public API (src/core/index.ts) the checker needs. */
export interface ConformanceApi {
  compile(source: string): CompileResult
  run(program: Program, options: RunOptions): RunResult
  record(program: Program, options: RecordOptions): RecordingSummary
}

export interface CheckResult {
  readonly ok: boolean
  /** Human-readable descriptions of every disagreement; empty when `ok`. */
  readonly failures: readonly string[]
}

/** The expectations of one file, after its annotations were validated. */
interface Expectations {
  readonly outputs: readonly string[]
  readonly compileErrors: readonly ErrorAnnotation[]
  readonly runtimeError: ErrorAnnotation | null
}

const OPTIONS = { maxSteps: CONFORMANCE_MAX_STEPS, seed: CONFORMANCE_SEED } as const

/** Checks one annotated source against the API. Never throws for API exceptions: they fail it. */
export function checkSource(source: string, api: ConformanceApi): CheckResult {
  const annotations = parseAnnotations(source)
  const problems = validateAnnotations(annotations)
  if (problems.length > 0) return result(problems)
  const expectations = collectExpectations(annotations)
  const lines = new LineIndex(source)

  const compiled = attempt('compile', () => api.compile(source))
  if (typeof compiled === 'string') return result([compiled])
  if (expectations.compileErrors.length > 0) {
    return result(checkCompileErrors(compiled, expectations.compileErrors, lines))
  }
  if (!compiled.ok) {
    return result([describeCompileFailure(compiled.diagnostics, lines)])
  }
  return result(checkExecution(compiled.program, expectations, api, lines))
}

/** The actual output lines: event texts joined with `\n`, split on `\n`, right-trimmed. */
export function outputLines(outputs: readonly OutputEvent[]): string[] {
  if (outputs.length === 0) return []
  return outputs
    .map((event) => event.text)
    .join('\n')
    .split('\n')
    .map((line) => line.trimEnd())
}

function result(failures: readonly string[]): CheckResult {
  return { ok: failures.length === 0, failures }
}

/** File-level rules: no malformed annotations; compile errors alone; one runtime error at most. */
function validateAnnotations(annotations: readonly Annotation[]): string[] {
  const problems = annotations
    .filter((annotation) => annotation.kind === 'malformed')
    .map((annotation) => `line ${annotation.line}: malformed annotation '${annotation.raw}'`)
  const compileErrors = annotations.filter((annotation) => annotation.kind === 'compile-error')
  const others = annotations.filter(
    (annotation) => annotation.kind === 'output' || annotation.kind === 'runtime-error',
  )
  if (compileErrors.length > 0 && others.length > 0) {
    const where = others.map((annotation) => annotation.line).join(', ')
    problems.push(
      `a file with compile-error annotations cannot contain other annotations (line ${where})`,
    )
  }
  const runtimeErrors = annotations.filter((annotation) => annotation.kind === 'runtime-error')
  if (runtimeErrors.length > 1) {
    const where = runtimeErrors.map((annotation) => annotation.line).join(', ')
    problems.push(`at most one runtime-error annotation is allowed (lines ${where})`)
  }
  return problems
}

function collectExpectations(annotations: readonly Annotation[]): Expectations {
  const outputs: string[] = []
  const compileErrors: ErrorAnnotation[] = []
  let runtimeError: ErrorAnnotation | null = null
  for (const annotation of annotations) {
    if (annotation.kind === 'output') outputs.push(annotation.text)
    else if (annotation.kind === 'compile-error') compileErrors.push(annotation)
    else if (annotation.kind === 'runtime-error') runtimeError = annotation
  }
  return { outputs, compileErrors, runtimeError }
}

/** Runs `action`, turning a thrown exception into a failure description. */
function attempt<T>(what: string, action: () => T): T | string {
  try {
    return action()
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return `${what} threw an exception: ${detail}`
  }
}

function reportDiagnostic(diagnostic: Diagnostic, lines: LineIndex): ReportedError {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    hint: diagnostic.hint,
    line: lines.lineOf(diagnostic.span.start),
  }
}

function describeCompileFailure(diagnostics: readonly Diagnostic[], lines: LineIndex): string {
  const details = diagnostics.map((d) => `\n  ${describeReported(reportDiagnostic(d, lines))}`)
  return `expected the program to compile, but compilation failed:${details.join('')}`
}

/** Both directions: every diagnostic is annotated, and every annotation matches a diagnostic. */
function checkCompileErrors(
  compiled: CompileResult,
  annotations: readonly ErrorAnnotation[],
  lines: LineIndex,
): string[] {
  if (compiled.ok) return ['expected compilation to fail, but it succeeded']
  const reported = compiled.diagnostics.map((d) => reportDiagnostic(d, lines))
  const failures: string[] = []
  for (const diagnostic of reported) {
    if (!annotations.some((annotation) => matchesAnnotation(annotation, diagnostic))) {
      failures.push(`unexpected diagnostic: ${describeReported(diagnostic)}`)
    }
  }
  for (const annotation of annotations) {
    if (!reported.some((diagnostic) => matchesAnnotation(annotation, diagnostic))) {
      failures.push(`no diagnostic matches the annotation: ${describeAnnotation(annotation)}`)
    }
  }
  return failures
}

function checkExecution(
  program: Program,
  expectations: Expectations,
  api: ConformanceApi,
  lines: LineIndex,
): string[] {
  const run = attempt('run', () => api.run(program, OPTIONS))
  if (typeof run === 'string') return [run]
  const failures = [
    ...compareOutputs(expectations.outputs, outputLines(run.outputs)),
    ...checkOutcome(run, expectations.runtimeError, lines),
  ]
  if (failures.length > 0) return failures
  const recording = attempt('record', () => api.record(program, OPTIONS))
  if (typeof recording === 'string') return [recording]
  return compareRunWithRecording(run, recording)
}

function compareOutputs(expected: readonly string[], actual: readonly string[]): string[] {
  const length = Math.max(expected.length, actual.length)
  for (let i = 0; i < length; i++) {
    if (expected[i] !== actual[i]) {
      return [
        `output differs at output line ${i + 1} (expected ${expected.length} lines, got ` +
          `${actual.length}):\n  expected: ${quoteLine(expected[i])}\n  actual:   ` +
          `${quoteLine(actual[i])}`,
      ]
    }
  }
  return []
}

function quoteLine(line: string | undefined): string {
  return line === undefined ? '(no line)' : JSON.stringify(line)
}

function checkOutcome(
  run: RunResult,
  expected: ErrorAnnotation | null,
  lines: LineIndex,
): string[] {
  const outcome = run.outcome
  const wanted = expected === null ? '' : ` (expected ${describeAnnotation(expected)})`
  switch (outcome.kind) {
    case 'finished':
      return expected === null ? [] : [`the program finished without a runtime error${wanted}`]
    case 'step-limit':
      return [`the program did not finish within ${outcome.maxSteps} steps${wanted}`]
    case 'aborted':
      return [`the run was aborted${wanted}`]
    case 'error': {
      const actual: ReportedError = {
        code: outcome.error.code,
        message: outcome.error.message,
        hint: outcome.error.hint,
        line: lines.lineOf(outcome.error.span.start),
      }
      if (expected === null) return [`unexpected runtime error: ${describeReported(actual)}`]
      if (matchesAnnotation(expected, actual)) return []
      return [
        `the runtime error does not match the annotation:\n  expected: ` +
          `${describeAnnotation(expected)}\n  actual:   ${describeReported(actual)}`,
      ]
    }
  }
}

function describeAnnotation(annotation: ErrorAnnotation): string {
  const kind = annotation.kind === 'compile-error' ? 'compile error' : 'runtime error'
  const code = annotation.code === null ? '' : ` ${annotation.code}`
  const text = annotation.text === null ? '' : `: ${annotation.text}`
  const hint = annotation.hint === null ? '' : ` // hint: ${annotation.hint}`
  return `line ${annotation.line}: ${kind}${code}${text}${hint}`
}
