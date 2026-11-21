/**
 * What the extension shows, computed from a recording: problems, code lenses (call counts and
 * code that never ran), why-not sentences, crash slices and the run report. Nothing here imports
 * `vscode`, so it is unit-tested with Vitest from the repository root; `glue/` turns these plain
 * values into editor objects. Lines are 1-based, as in the core; columns are 1-based too.
 */
import {
  compile,
  type Diagnostic,
  errorSlice,
  LineIndex,
  type Outcome,
  type Program,
  type Recording,
  recordAsync,
  whyNot,
} from '../../../src/core/index'

/** The step budget for a run unless the user configures another (one step = one instruction). */
export const DEFAULT_MAX_STEPS = 2_000_000

export interface Position {
  readonly line: number
  readonly column: number
}

/** A compile diagnostic or a runtime error, placed in the source. */
export interface Problem {
  readonly severity: 'error' | 'warning'
  readonly code: string
  readonly message: string
  readonly start: Position
  readonly end: Position
}

export interface AnalysisOptions {
  readonly maxSteps?: number
  /** Set by a newer run: the recording stops and the analysis reports `aborted`. */
  readonly signal?: { readonly aborted: boolean }
  /** Work per slice before yielding to the event loop (the extension host must stay responsive). */
  readonly sliceMs?: number
}

export type Analysis =
  | { readonly kind: 'compile-error'; readonly problems: readonly Problem[] }
  | {
      readonly kind: 'recorded'
      readonly recording: Recording
      /** Compiler warnings and, when the run failed, its runtime error. */
      readonly problems: readonly Problem[]
    }
  | { readonly kind: 'aborted' }

/** What a compile diagnostic and a runtime error have in common. */
interface Located {
  readonly code: string
  readonly message: string
  readonly hint?: string
  readonly span: Diagnostic['span']
}

function problem(lines: LineIndex, diagnostic: Located) {
  const start = lines.lineCol(diagnostic.span.start)
  const end = lines.lineCol(Math.max(diagnostic.span.start, diagnostic.span.end))
  return {
    code: diagnostic.code,
    message:
      diagnostic.hint === undefined
        ? diagnostic.message
        : `${diagnostic.message}\nhint: ${diagnostic.hint}`,
    start: { line: start.line, column: start.col },
    end: { line: end.line, column: end.col },
  }
}

/** Compiles and records `source`; compile errors and runtime errors become problems. */
export async function analyze(source: string, options: AnalysisOptions = {}): Promise<Analysis> {
  const lines = new LineIndex(source)
  const compiled = compile(source)
  const diagnostics = compiled.diagnostics.map((d) => ({
    ...problem(lines, d),
    severity: d.severity === 'error' ? ('error' as const) : ('warning' as const),
  }))
  if (!compiled.ok) return { kind: 'compile-error', problems: diagnostics }
  const recording = await recordAsync(compiled.program, {
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    signal: options.signal,
    sliceMs: options.sliceMs,
  })
  if (recording.outcome.kind === 'aborted' || options.signal?.aborted) return { kind: 'aborted' }
  const runtime =
    recording.outcome.kind === 'error'
      ? [{ ...problem(lines, recording.outcome.error), severity: 'error' as const }]
      : []
  return { kind: 'recorded', recording, problems: [...diagnostics, ...runtime] }
}

// ---------------------------------------------------------------------------------------------
// Code lenses

export interface FunctionLens {
  /** The line of the `fn` keyword. */
  readonly line: number
  readonly name: string
  readonly calls: number
  readonly title: string
}

export interface NeverRanLens {
  /** The first line of a stretch of statements that never ran. */
  readonly line: number
  /** How many statement lines the stretch holds. */
  readonly lines: number
  readonly title: string
}

const count = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? '' : 's'}`

/**
 * Calls per function prototype in the last run. A call begins at a step whose frame depth exceeds
 * the previous step's (the call tree's own rule, ARCHITECTURE §7.6), the step at N included: a call
 * can fail on its first instruction. One pass over the depth series, no object per call.
 */
function callsPerProto(recording: Recording): ReadonlyMap<number, number> {
  const depths = recording.depthSeries()
  const n = recording.length
  const counts = new Map<number, number>()
  for (let t = 1; t <= n; t++) {
    const depth = t < n ? depths[t]! : recording.depthAt(n)
    if (depth <= depths[t - 1]!) continue
    const protoId = recording.locationAt(t)?.protoId
    if (protoId !== undefined) counts.set(protoId, (counts.get(protoId) ?? 0) + 1)
  }
  return counts
}

const DECLARATION = /^fn\s+([A-Za-z_][A-Za-z0-9_]*)/

/** One lens per `fn name(...)` declaration in the program: how often the last run called it. */
export function functionLenses(recording: Recording): FunctionLens[] {
  const { source } = recording.program
  const lines = new LineIndex(source)
  const calls = callsPerProto(recording)
  const lenses: FunctionLens[] = []
  for (const proto of recording.program.protos) {
    if (proto.kind !== 'function' || proto.debug.source !== 'main') continue
    const start = proto.debug.span.start
    const name = DECLARATION.exec(source.slice(start, start + 200))?.[1]
    if (name === undefined) continue
    const n = calls.get(proto.id) ?? 0
    const title = n === 0 ? 'never called' : n === 1 ? 'ran once' : `ran ${count(n)} times`
    lenses.push({ line: lines.lineOf(start), name, calls: n, title })
  }
  return lenses.sort((a, b) => a.line - b.line)
}

/** The lines on which a statement of the program starts (the lines `lineHitCounts` counts). */
export function statementLines(program: Program): number[] {
  const lines = new LineIndex(program.source)
  const found = new Set<number>()
  for (const proto of program.protos) {
    if (proto.debug.source !== 'main') continue
    const { stmtStart, stmtSpanStart } = proto.debug
    for (let ip = 0; ip < proto.code.length; ip++)
      if (stmtStart[ip] === 1) found.add(lines.lineOf(stmtSpanStart[ip] ?? 0))
  }
  return [...found].sort((a, b) => a - b)
}

/**
 * Lenses over code the last run never reached: one per stretch of statement lines that never ran
 * (the statement lines between two that ran), so an untaken branch gets one lens, not one per line.
 */
export function neverRanLenses(recording: Recording): NeverRanLens[] {
  const hits = recording.lineHitCounts()
  const lenses: NeverRanLens[] = []
  let first = 0
  let size = 0
  const close = () => {
    if (size === 0) return
    const what = size === 1 ? 'never ran' : `never ran (${plural(size, 'line')})`
    lenses.push({ line: first, lines: size, title: `${what} — why not?` })
    size = 0
  }
  for (const line of statementLines(recording.program)) {
    if ((hits.get(line) ?? 0) > 0) {
      close()
      continue
    }
    if (size === 0) first = line
    size += 1
  }
  close()
  return lenses
}

// ---------------------------------------------------------------------------------------------
// Why not, crash slices, the run report

/** The why-not sentence for `line`, as the inline decoration shows it. */
export function whyNotSentence(recording: Recording, line: number): string {
  return whyNot(recording, line).sentence
}

export type CrashSlice =
  | {
      readonly kind: 'sliced'
      /** Lines with a step in the slice of the crash. */
      readonly keep: readonly number[]
      /** Every other line of the source: the ones to dim. */
      readonly dim: readonly number[]
      readonly message: string
    }
  | { readonly kind: 'no-crash' | 'unavailable'; readonly message: string }

/** The lines that led to the run's runtime error, and the lines to dim around them. */
export function crashSlice(recording: Recording): CrashSlice {
  const { outcome } = recording
  if (outcome.kind !== 'error')
    return { kind: 'no-crash', message: `The last run did not crash: it ${outcomeText(outcome)}.` }
  const slice = errorSlice(recording)
  if (slice === null) return { kind: 'unavailable', message: 'This run cannot be sliced.' }
  const total = new LineIndex(recording.program.source).lineCount
  const keep = [...slice.lines].sort((a, b) => a - b)
  const dim: number[] = []
  for (let line = 1; line <= total; line++) if (!slice.lines.has(line)) dim.push(line)
  return {
    kind: 'sliced',
    keep,
    dim,
    message: `${plural(keep.length, 'line')} led to ${outcome.error.code}: ${outcome.error.message}`,
  }
}

/** How a run that did not fail ended (a failed run is described with its error). */
function outcomeText(outcome: Exclude<Outcome, { kind: 'error' }>): string {
  switch (outcome.kind) {
    case 'finished':
      return 'finished normally'
    case 'step-limit':
      return `stopped at the step limit (${count(outcome.maxSteps)} steps)`
    default:
      return 'was stopped'
  }
}

/** What "Run File" prints: the output, then how the run ended. */
export function runReport(recording: Recording, fileName: string): string[] {
  const lines = recording.outputs.map((event) => event.text)
  const { outcome } = recording
  const steps = plural(recording.length, 'step')
  if (outcome.kind === 'error') {
    const at = new LineIndex(recording.program.source).lineOf(outcome.error.span.start)
    lines.push(
      `[${fileName}:${at}] runtime error ${outcome.error.code}: ${outcome.error.message} (after ${steps})`,
    )
    if (outcome.error.hint !== undefined) lines.push(`  hint: ${outcome.error.hint}`)
  } else if (outcome.kind === 'step-limit') {
    lines.push(`[${fileName}] ${outcomeText(outcome)}; raise hindsight.maxSteps to record further`)
  } else {
    lines.push(`[${fileName}] ${outcomeText(outcome)} after ${steps}`)
  }
  return lines
}

/** The step "Open in Studio" puts the pen on: the cursor line's first run, else the run's end. */
export function momentFor(recording: Recording, line: number): number {
  return recording.lineHits(line)[0] ?? recording.length
}
