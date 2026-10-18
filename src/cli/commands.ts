import type {
  ProvenanceEvent,
  Recording,
  StateView,
  TracedValue,
  WriteTarget,
} from '../core/api-types'
import { compile, disassemble, LineIndex, record, run } from '../core/index'
import type { Program } from '../core/bytecode'
import { checkSource } from '../conformance/check'
import type { Command } from './args'
import {
  codeFrame,
  formatDiagnostic,
  formatRuntimeError,
  formatValueView,
  makeStyle,
  type Style,
} from './format'
import type { CliIO } from './io'

export type ExitCode = 0 | 1 | 2

interface Loaded {
  readonly file: string
  readonly source: string
  readonly program: Program
}

/** Reads and compiles a file, printing diagnostics on failure. */
function load(io: CliIO, style: Style, file: string): Loaded | null {
  let source: string
  try {
    source = io.readFile(file)
  } catch (error) {
    io.stderr(`${style.error('error')}: cannot read '${file}': ${(error as Error).message}\n`)
    return null
  }
  const result = compile(source)
  if (!result.ok) {
    for (const diagnostic of result.diagnostics)
      io.stderr(`${formatDiagnostic(file, source, diagnostic, style)}\n\n`)
    const count = result.diagnostics.length
    io.stderr(`${style.error(`${count} error${count === 1 ? '' : 's'}`)} in ${file}\n`)
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
      io.stdout(`${style.ok('ok')}: ${command.file} compiles without errors\n`)
      return 0
    }
    case 'disasm': {
      const loaded = load(io, style, command.file)
      if (!loaded) return 1
      io.stdout(`${disassemble(loaded.program)}\n`)
      return 0
    }
    case 'replay':
      return replay(io, style, command.file, command.at, command.maxSteps, command.seed)
    case 'why':
      return why(io, style, command)
    case 'test':
      return test(io, style, command.dir)
    default:
      return 0
  }
}

function runFile(io: CliIO, style: Style, file: string, maxSteps: number, seed: number): ExitCode {
  const loaded = load(io, style, file)
  if (!loaded) return 1
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
  if (outcome.kind === 'error') return `ends with ${outcome.error.code}: ${outcome.error.message}`
  if (outcome.kind === 'finished') return 'finishes normally'
  return `stops at the step limit`
}

function describeLocation(view: StateView, source: string, style: Style): string[] {
  const location = view.location
  if (!location) return [style.dim('the program has finished')]
  if (location.source !== 'main')
    return [`inside library function ${location.functionName} (${location.opName})`]
  const { line, col } = new LineIndex(source).lineCol(location.span.start)
  return [
    `line ${line}, column ${col} · in ${location.functionName} · next instruction ${location.opName}`,
    ...codeFrame(source, location.span, style),
  ]
}

function describeFrames(view: StateView, source: string, style: Style): string[] {
  if (view.frames.length === 0) return []
  const index = new LineIndex(source)
  const lines = [style.bold('frames (innermost first):')]
  for (const frame of [...view.frames].reverse()) {
    const where = frame.library ? 'library' : `line ${index.lineOf(frame.span.start)}`
    lines.push(`  ${frame.name} ${style.dim(`(${where})`)}`)
    for (const local of frame.locals)
      lines.push(`    ${local.name} = ${formatValueView(local.value)}`)
    for (const capture of frame.captures)
      lines.push(
        `    ${capture.name} = ${formatValueView(capture.value)} ${style.dim('(captured)')}`,
      )
  }
  return lines
}

function describeGlobals(view: StateView, style: Style): string[] {
  if (view.globals.length === 0) return []
  return [
    style.bold('globals:'),
    ...view.globals.map((g) => `  ${g.name} = ${formatValueView(g.value)}`),
  ]
}

function describeOutput(recording: Recording, view: StateView, style: Style): string[] {
  const printed = recording.outputs.slice(0, view.outputCount)
  if (printed.length === 0) return [style.dim('no output yet')]
  const shown = printed.slice(-10)
  const header = `output so far (${printed.length} line${printed.length === 1 ? '' : 's'}${printed.length > shown.length ? ', last 10 shown' : ''}):`
  return [style.bold(header), ...shown.map((event) => `  ${event.text}`)]
}

// --- why ----------------------------------------------------------------------------------------

interface Binding {
  readonly target: WriteTarget
  readonly at: number
  readonly where: string
}

/** Finds the first activation of variable `name` declared on `line`. */
export function findBinding(
  recording: Recording,
  source: string,
  line: number,
  name: string,
): Binding | null {
  const index = new LineIndex(source)
  const global = recording.program.globals.find(
    (g) => g.name === name && index.lineOf(g.declSpan.start) === line,
  )
  if (global) return { target: { kind: 'global', name }, at: recording.length, where: 'global' }
  for (const proto of recording.program.protos) {
    const local = proto.debug.locals.find(
      (l) => l.name === name && !l.hidden && index.lineOf(l.declSpan.start) === line,
    )
    if (!local) continue
    for (let t = 0; t < recording.length; t++) {
      const location = recording.locationAt(t)
      if (
        location?.protoId !== proto.id ||
        location.ip < local.startIp ||
        location.ip >= local.endIp
      )
        continue
      const frame = recording.stateAt(t).frames.at(-1)
      if (!frame) continue
      return {
        target: { kind: 'local', frameUid: frame.uid, slot: local.slot },
        at: t,
        where: proto.name ?? 'lambda',
      }
    }
  }
  return null
}

function tracedText(value: TracedValue): string {
  if (value === null) return 'nil'
  if (typeof value === 'object') return `<object #${value.ref}>`
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function eventLine(recording: Recording, source: string, event: ProvenanceEvent): string {
  const location = recording.locationAt(event.time)
  if (!location || location.source !== 'main') return 'library'
  return `line ${new LineIndex(source).lineOf(location.stmtSpan.start)}`
}

function why(io: CliIO, style: Style, command: Extract<Command, { kind: 'why' }>): ExitCode {
  const loaded = load(io, style, command.file)
  if (!loaded) return 1
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const binding = findBinding(recording, loaded.source, command.line, command.name)
  if (!binding) {
    io.stderr(
      `${style.error('error')}: no variable '${command.name}' declared on line ${command.line} was ever live in this run\n`,
    )
    return 1
  }
  const history = recording.history(binding.target, binding.at, { limit: 200 })
  const lines = [
    style.bold(
      `history of '${command.name}' (declared on line ${command.line}, ${binding.where}):`,
    ),
  ]
  for (const event of history.events) {
    const step = `step ${event.time.toLocaleString('en-US')}`.padEnd(14)
    lines.push(
      `  ${style.dim(step)} ${event.kind.padEnd(8)} ${command.name} = ${tracedText(event.value)}  ${style.dim(eventLine(recording, loaded.source, event))}`,
    )
  }
  if (history.truncated) lines.push(style.dim(`  (${history.total} events in all; evenly sampled)`))
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}

// --- test ---------------------------------------------------------------------------------------

function test(io: CliIO, style: Style, dir: string): ExitCode {
  let files: string[]
  try {
    files = io.listFiles(dir, '.sight')
  } catch (error) {
    io.stderr(`${style.error('error')}: cannot list '${dir}': ${(error as Error).message}\n`)
    return 1
  }
  let failed = 0
  for (const file of files) {
    const path = `${dir.replace(/\/$/, '')}/${file}`
    const result = checkSource(io.readFile(path), { compile, run, record })
    if (result.ok) {
      io.stdout(`${style.ok('✓')} ${file}\n`)
      continue
    }
    failed++
    io.stdout(`${style.error('✗')} ${file}\n`)
    for (const failure of result.failures) io.stdout(`    ${failure}\n`)
  }
  const passed = files.length - failed
  io.stdout(`\n${passed} passed, ${failed} failed (${files.length} files)\n`)
  return failed === 0 ? 0 : 1
}
