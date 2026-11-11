import type {
  LocalInfo,
  Program,
  ProvenanceEvent,
  Recording,
  StateView,
  TracedValue,
  WriteTarget,
} from '../core/index'
import { compile, disassemble, LineIndex, record, run } from '../core/index'
import { checkSource } from '../conformance/check'
import type { Command } from './args'
import {
  codeFrame,
  formatDiagnostic,
  formatRuntimeError,
  formatValueView,
  makeStyle,
  sanitize,
  type Style,
} from './format'
import type { CliIO } from './io'
import { query, repair, slice, solve, whyNotCommand } from './lab'
import { whatIf } from './whatif'

export type ExitCode = 0 | 1 | 2

export interface Loaded {
  readonly file: string
  readonly source: string
  readonly program: Program
}

/** Reads and compiles a file, printing diagnostics on failure. */
export function load(io: CliIO, style: Style, file: string): Loaded | null {
  let source: string
  try {
    source = io.readFile(file)
  } catch (error) {
    io.stderr(
      `${style.error('error')}: cannot read '${sanitize(file)}': ${sanitize((error as Error).message)}\n`,
    )
    return null
  }
  const result = compile(source)
  if (!result.ok) {
    for (const diagnostic of result.diagnostics)
      io.stderr(`${formatDiagnostic(file, source, diagnostic, style)}\n\n`)
    const count = result.diagnostics.length
    io.stderr(`${style.error(`${count} error${count === 1 ? '' : 's'}`)} in ${sanitize(file)}\n`)
    return null
  }
  return { file, source, program: result.program }
}

export function runCommand(command: Command, io: CliIO): ExitCode {
  const style = makeStyle(io.color)
  switch (command.kind) {
    case 'run':
      return runFile(io, style, command.file, command.maxSteps, command.seed)
    case 'check': {
      const loaded = load(io, style, command.file)
      if (!loaded) return 1
      io.stdout(`${style.ok('ok')}: ${sanitize(command.file)} compiles without errors\n`)
      return 0
    }
    case 'disasm': {
      const loaded = load(io, style, command.file)
      if (!loaded) return 1
      io.stdout(`${sanitize(disassemble(loaded.program))}\n`)
      return 0
    }
    case 'replay':
      return replay(io, style, command.file, command.at, command.maxSteps, command.seed)
    case 'why':
      return why(io, style, command)
    case 'test':
      return test(io, style, command.dir)
    case 'whatif': {
      const loaded = load(io, style, command.file)
      return loaded ? whatIf(io, style, loaded, command) : 1
    }
    case 'solve': {
      const loaded = load(io, style, command.file)
      return loaded ? solve(io, style, loaded, command) : 1
    }
    case 'query': {
      const loaded = load(io, style, command.file)
      return loaded ? query(io, style, loaded, command) : 1
    }
    case 'whynot': {
      const loaded = load(io, style, command.file)
      return loaded ? whyNotCommand(io, style, loaded, command) : 1
    }
    case 'slice': {
      const loaded = load(io, style, command.file)
      return loaded ? slice(io, style, loaded, command) : 1
    }
    case 'repair': {
      const loaded = load(io, style, command.file)
      return loaded ? repair(io, style, loaded, command) : 1
    }
    default:
      return 0
  }
}

function runFile(io: CliIO, style: Style, file: string, maxSteps: number, seed: number): ExitCode {
  const loaded = load(io, style, file)
  if (!loaded) return 1
  // Program output is the program's own: it is passed through raw, like any program's stdout.
  const result = run(loaded.program, { maxSteps, seed, onOutput: (text) => io.stdout(`${text}\n`) })
  switch (result.outcome.kind) {
    case 'finished':
      return 0
    case 'error':
      io.stderr(`\n${formatRuntimeError(file, loaded.source, result.outcome.error, style)}\n`)
      return 1
    default:
      io.stderr(
        `\n${style.error('stopped')}: reached the step limit of ${maxSteps.toLocaleString('en-US')} steps (use --max-steps)\n`,
      )
      return 2
  }
}

// --- replay -------------------------------------------------------------------------------------

function replay(
  io: CliIO,
  style: Style,
  file: string,
  at: number,
  maxSteps: number,
  seed: number,
): ExitCode {
  const loaded = load(io, style, file)
  if (!loaded) return 1
  const recording = record(loaded.program, { maxSteps, seed })
  const time = Math.min(at, recording.length)
  const view = recording.stateAt(time)
  const lines = [
    `${style.bold(`step ${time.toLocaleString('en-US')}`)} of ${recording.length.toLocaleString('en-US')} ${style.dim(`(${outcomeText(recording)})`)}`,
    ...describeLocation(view, loaded.source, style),
    ...describeFrames(view, loaded.source, style),
    ...describeGlobals(view, style),
    ...describeOutput(recording, view, style),
  ]
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}

function outcomeText(recording: Recording): string {
  const outcome = recording.outcome
  if (outcome.kind === 'error')
    return `ends with ${outcome.error.code}: ${sanitize(outcome.error.message)}`
  if (outcome.kind === 'finished') return 'finishes normally'
  return `stops at the step limit`
}

function describeLocation(view: StateView, source: string, style: Style): string[] {
  const location = view.location
  if (!location) return [style.dim('the program has finished')]
  if (location.source !== 'main')
    return [`inside library function ${sanitize(location.functionName)} (${location.opName})`]
  const { line, col } = new LineIndex(source).lineCol(location.span.start)
  return [
    `line ${line}, column ${col} · in ${sanitize(location.functionName)} · next instruction ${location.opName}`,
    ...codeFrame(source, location.span, style),
  ]
}

function describeFrames(view: StateView, source: string, style: Style): string[] {
  if (view.frames.length === 0) return []
  const index = new LineIndex(source)
  const lines = [style.bold('frames (innermost first):')]
  for (const frame of [...view.frames].reverse()) {
    const where = frame.library ? 'library' : `line ${index.lineOf(frame.span.start)}`
    lines.push(`  ${sanitize(frame.name)} ${style.dim(`(${where})`)}`)
    for (const local of frame.locals)
      lines.push(`    ${sanitize(local.name)} = ${formatValueView(local.value)}`)
    for (const capture of frame.captures)
      lines.push(
        `    ${sanitize(capture.name)} = ${formatValueView(capture.value)} ${style.dim('(captured)')}`,
      )
  }
  return lines
}

function describeGlobals(view: StateView, style: Style): string[] {
  if (view.globals.length === 0) return []
  return [
    style.bold('globals:'),
    ...view.globals.map((g) => `  ${sanitize(g.name)} = ${formatValueView(g.value)}`),
  ]
}

function describeOutput(recording: Recording, view: StateView, style: Style): string[] {
  const printed = recording.outputs.slice(0, view.outputCount)
  if (printed.length === 0) return [style.dim('no output yet')]
  const shown = printed.slice(-10)
  const header = `output so far (${printed.length} line${printed.length === 1 ? '' : 's'}${printed.length > shown.length ? ', last 10 shown' : ''}):`
  // Unlike `run`, replay shows output inside the debugger's own report, so it is sanitized.
  return [style.bold(header), ...shown.map((event) => `  ${sanitize(event.text)}`)]
}

// --- why ----------------------------------------------------------------------------------------

/** The most calls of a function `why` lists one by one; the rest are only counted. */
export const MAX_WHY_CALLS = 50

/** One binding of a variable: a global, or a local in one call of its function. */
interface Binding {
  readonly target: WriteTarget
  readonly at: number
}

interface Bindings {
  readonly where: string
  /** The global's binding, or one binding per call (in call order, at most MAX_WHY_CALLS). */
  readonly bindings: readonly Binding[]
  /** Calls in which the local was in scope; can exceed `bindings.length`. */
  readonly calls: number
}

/** Finds variable `name` declared on `line`: a global, or a local with a binding per call. */
export function findBindings(
  recording: Recording,
  source: string,
  line: number,
  name: string,
): Bindings | null {
  const index = new LineIndex(source)
  const global = recording.program.globals.find(
    (g) => g.name === name && index.lineOf(g.declSpan.start) === line,
  )
  if (global) {
    const binding = { target: { kind: 'global', name } as const, at: recording.length }
    return { where: 'global', bindings: [binding], calls: 1 }
  }
  for (const proto of recording.program.protos) {
    const local = proto.debug.locals.find(
      (l) => l.name === name && !l.hidden && index.lineOf(l.declSpan.start) === line,
    )
    if (!local) continue
    const starts = firstStepsInScope(recording, proto.id, local)
    if (starts.length === 0) continue
    const bindings = starts.slice(0, MAX_WHY_CALLS).flatMap((at): Binding[] => {
      const frame = recording.stateAt(at).frames.at(-1)
      if (!frame) return []
      return [{ target: { kind: 'local', frameUid: frame.uid, slot: local.slot }, at }]
    })
    return { where: proto.name ?? 'lambda', bindings, calls: starts.length }
  }
  return null
}

/**
 * For each call of function `protoId`, the first step at which `local` is in scope. A call begins
 * where the trace enters a depth from a shallower one, so recursive calls stay apart.
 */
function firstStepsInScope(recording: Recording, protoId: number, local: LocalInfo): number[] {
  const depths = recording.depthSeries()
  const callStarts: number[] = []
  const listed = new Set<number>()
  const steps: number[] = []
  for (let t = 0; t < recording.length; t++) {
    const depth = depths[t]!
    if (t === 0 || depths[t - 1]! < depth) callStarts[depth] = t
    const location = recording.locationAt(t)
    if (location?.protoId !== protoId || location.ip < local.startIp || location.ip >= local.endIp)
      continue
    const call = callStarts[depth]!
    if (listed.has(call)) continue
    listed.add(call)
    steps.push(t)
  }
  return steps
}

function tracedText(value: TracedValue): string {
  if (value === null) return 'nil'
  if (typeof value === 'object') return `<object #${value.ref}>`
  return typeof value === 'string' ? sanitize(JSON.stringify(value)) : String(value)
}

function eventLine(recording: Recording, source: string, event: ProvenanceEvent): string {
  const location = recording.locationAt(event.time)
  if (!location || location.source !== 'main') return 'library'
  return `line ${new LineIndex(source).lineOf(location.stmtSpan.start)}`
}

/** The history of one binding, one event per line, each line starting with `indent`. */
function historyLines(
  recording: Recording,
  source: string,
  style: Style,
  name: string,
  binding: Binding,
  indent: string,
): string[] {
  const history = recording.history(binding.target, binding.at, { limit: 200 })
  const lines = history.events.map((event) => {
    const step = `step ${event.time.toLocaleString('en-US')}`.padEnd(14)
    const where = style.dim(eventLine(recording, source, event))
    return `${indent}${style.dim(step)} ${event.kind.padEnd(8)} ${name} = ${tracedText(event.value)}  ${where}`
  })
  if (history.truncated)
    lines.push(style.dim(`${indent}(${history.total} events in all; evenly sampled)`))
  return lines
}

function why(io: CliIO, style: Style, command: Extract<Command, { kind: 'why' }>): ExitCode {
  const loaded = load(io, style, command.file)
  if (!loaded) return 1
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const found = findBindings(recording, loaded.source, command.line, command.name)
  const name = sanitize(command.name)
  if (!found) {
    io.stderr(
      `${style.error('error')}: no variable '${name}' declared on line ${command.line} was ever live in this run\n`,
    )
    return 1
  }
  const several = found.calls > 1
  const calls = several ? `; ${found.calls.toLocaleString('en-US')} calls` : ''
  const lines = [
    style.bold(
      `history of '${name}' (declared on line ${command.line}, ${sanitize(found.where)}${calls}):`,
    ),
  ]
  found.bindings.forEach((binding, index) => {
    if (several) lines.push(`  ${style.accent(`call ${index + 1}`)}`)
    lines.push(
      ...historyLines(recording, loaded.source, style, name, binding, several ? '    ' : '  '),
    )
  })
  const unlisted = found.calls - found.bindings.length
  if (unlisted > 0)
    lines.push(style.dim(`  (${unlisted.toLocaleString('en-US')} more calls not listed)`))
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}

// --- test ---------------------------------------------------------------------------------------

function test(io: CliIO, style: Style, dir: string): ExitCode {
  let files: string[]
  try {
    files = io.listFiles(dir, '.sight')
  } catch (error) {
    io.stderr(
      `${style.error('error')}: cannot list '${sanitize(dir)}': ${sanitize((error as Error).message)}\n`,
    )
    return 1
  }
  let failed = 0
  for (const file of files) {
    const path = `${dir.replace(/\/$/, '')}/${file}`
    const result = checkSource(io.readFile(path), { compile, run, record })
    if (result.ok) {
      io.stdout(`${style.ok('✓')} ${sanitize(file)}\n`)
      continue
    }
    failed++
    io.stdout(`${style.error('✗')} ${sanitize(file)}\n`)
    for (const failure of result.failures) io.stdout(`    ${sanitize(failure)}\n`)
  }
  const passed = files.length - failed
  io.stdout(`\n${passed} passed, ${failed} failed (${files.length} files)\n`)
  return failed === 0 ? 0 : 1
}
