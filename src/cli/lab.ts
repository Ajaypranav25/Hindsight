/**
 * The laboratory commands (ARCHITECTURE §9): `solve` (inverse what-if), `query` (the temporal
 * query language), `whynot` (negative provenance), `slice` (fault localization) and `repair`
 * (one-token repair previews). Each records the program and prints what the core found.
 */
import {
  backwardSlice,
  errorSlice,
  LineIndex,
  type ProvenanceEvent,
  queryRecording,
  type QueryResult,
  record,
  type Recording,
  type RepairRequest,
  type RepairResult,
  repairSearch,
  solveInverse,
  type TracedValue,
  whyNot,
  writeName,
} from '../core/index'
import type { Command } from './args'
import type { ExitCode, Loaded } from './commands'
import { sanitize, type Style } from './format'
import type { CliIO } from './io'

const count = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

function fail(io: CliIO, style: Style, message: string): 1 {
  io.stderr(`${style.error('error')}: ${sanitize(message)}\n`)
  return 1
}

// --- solve --------------------------------------------------------------------------------------

export function solve(
  io: CliIO,
  style: Style,
  loaded: Loaded,
  command: Extract<Command, { kind: 'solve' }>,
): ExitCode {
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const { goal } = command
  let wanted: string
  let result
  if (goal.kind === 'no-error') {
    wanted = 'the run not to fail'
    result = solveInverse(recording, goal)
  } else {
    const index = (goal.line ?? recording.outputs.length) - 1
    const now = recording.outputs[index]?.text
    wanted = `output line ${index + 1} to read ${JSON.stringify(goal.text)}${now === undefined ? '' : ` (it reads ${JSON.stringify(now)})`}`
    result = solveInverse(recording, { kind: 'output', index, text: goal.text })
  }
  io.stdout(`${style.bold('goal')}: ${sanitize(wanted)}\n`)
  if (result.problem !== null) return fail(io, style, result.problem)
  const searched = `tried ${plural(result.candidates, 'earlier value')} in ${plural(result.forks, 'what-if run')}`
  if (result.solutions.length === 0) {
    const why = result.exhausted ? ' before the search budget ran out' : ''
    io.stdout(`No single earlier value reaches that${why} (${searched}).\n`)
    return 1
  }
  for (const solution of result.solutions) {
    const where =
      solution.candidate.line === null ? '' : style.dim(`  (line ${solution.candidate.line})`)
    io.stdout(`${style.ok('✓')} ${sanitize(solution.sentence)}${where}\n`)
  }
  io.stdout(`${style.dim(`${searched}${result.exhausted ? '; the budget ran out' : ''}`)}\n`)
  return 0
}

// --- query --------------------------------------------------------------------------------------

function lineText(recording: Recording, time: number): string {
  const location = recording.locationAt(Math.min(time, recording.length))
  if (location === null) return 'the end'
  return location.source === 'main' ? `line ${location.stmtLine}` : 'library'
}

function tracedText(value: TracedValue): string {
  if (value === null) return 'nil'
  if (typeof value === 'object') return `<object #${value.ref}>`
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function eventText(recording: Recording, event: ProvenanceEvent): string {
  const { target } = event
  const name = writeName(recording, event)
  const place =
    target.kind === 'field' || target.kind === 'element' || target.kind === 'object'
      ? `#${target.objectId}${target.kind === 'object' ? '' : (name ?? '')}`
      : (name ?? 'a variable')
  if (event.kind === 'list') return `${place} ${event.op ?? 'changed'} ${tracedText(event.value)}`
  if (event.kind === 'delete') return `${place} deleted`
  return `${place} = ${tracedText(event.value)}`
}

function queryLines(recording: Recording, result: QueryResult, style: Style): string[] {
  const step = (time: number) => style.dim(`step ${count(time)}`.padEnd(14))
  const more = result.truncated ? [style.dim('  … more not shown (raise --limit)')] : []
  switch (result.kind) {
    case 'when': {
      const head = `${plural(result.intervals.length, 'stretch', 'stretches')} (${plural(result.matches, 'statement')})`
      const rows = result.intervals.map(
        (interval) =>
          `  ${step(interval.from)} to step ${count(interval.to)} · ${lineText(recording, interval.from)}`,
      )
      return [style.bold(head), ...rows, ...more]
    }
    case 'changed': {
      const rows = result.events.map(
        (event) =>
          `  ${step(event.time)} ${sanitize(eventText(recording, event))}  ${style.dim(lineText(recording, event.time))}`,
      )
      return [style.bold(plural(result.total, 'change')), ...rows, ...more]
    }
    case 'calls': {
      const rows = result.calls.map((call) => `  ${step(call.entry)} ${sanitize(call.text)}`)
      return [style.bold(plural(result.total, 'call')), ...rows, ...more]
    }
  }
}

export function query(
  io: CliIO,
  style: Style,
  loaded: Loaded,
  command: Extract<Command, { kind: 'query' }>,
): ExitCode {
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const outcome = queryRecording(recording, command.text, { limit: command.limit })
  if (!outcome.ok) return fail(io, style, outcome.error)
  io.stdout(`${queryLines(recording, outcome.result, style).join('\n')}\n`)
  return 0
}

// --- whynot -------------------------------------------------------------------------------------

export function whyNotCommand(
  io: CliIO,
  style: Style,
  loaded: Loaded,
  command: Extract<Command, { kind: 'whynot' }>,
): ExitCode {
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const why = whyNot(recording, command.line)
  io.stdout(`${sanitize(why.sentence)}\n`)
  if (why.kind === 'guard') {
    const index = new LineIndex(loaded.source)
    const text = sanitize(index.lineText(why.guardLine).replace(/\t/g, ' '))
    io.stdout(`${style.dim(`${String(why.guardLine).padStart(4)} |`)} ${text}\n`)
    io.stdout(
      `${style.dim(`replay it: hindsight replay ${sanitize(loaded.file)} --at ${why.time}`)}\n`,
    )
  }
  return 0
}

// --- slice --------------------------------------------------------------------------------------

export function slice(
  io: CliIO,
  style: Style,
  loaded: Loaded,
  command: Extract<Command, { kind: 'slice' }>,
): ExitCode {
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  let at = command.at
  let about: string
  if (at !== null) {
    if (at > recording.length)
      return fail(io, style, `step ${count(at)} is after the end of the run`)
    about = `step ${count(at)}`
  } else if (recording.outcome.kind === 'error') {
    at = recording.length
    about = `the runtime error (${recording.outcome.error.code})`
  } else {
    const last = recording.outputs.at(-1)
    if (last === undefined)
      return fail(io, style, 'the run printed nothing: give a step with --at T')
    at = last.time
    about = `the last output line (${JSON.stringify(last.text)})`
  }
  const found = at === recording.length ? errorSlice(recording) : null
  const result = found ?? backwardSlice(recording, at)
  if (result === null) return fail(io, style, 'this run is too long to analyze')
  const ran = recording.lineHitCounts()
  const index = new LineIndex(loaded.source)
  const width = Math.max(3, String(index.lineCount).length)
  const head = `${plural(result.lines.size, 'line')} of the ${count(ran.size)} that ran led to ${sanitize(about)}`
  const lines = [style.bold(head)]
  // A source that ends with a newline has an empty last line: nothing to show.
  const lastLine = index.lineText(index.lineCount) === '' ? index.lineCount - 1 : index.lineCount
  for (let line = 1; line <= lastLine; line++) {
    const text = sanitize(index.lineText(line).replace(/\t/g, ' '))
    const number = String(line).padStart(width)
    lines.push(
      result.lines.has(line)
        ? `${style.accent('>')} ${number} | ${text}`
        : style.dim(`  ${number} | ${text}`),
    )
  }
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}

// --- repair -------------------------------------------------------------------------------------

/** Runs a repair search to the end. */
export function searchRepairs(recording: Recording, request: RepairRequest): RepairResult {
  const search = repairSearch(recording, request)
  let next = search.next()
  while (next.done !== true) next = search.next()
  return next.value
}

/** The repairs as lines: the change, the line before and after, and what it does. */
export function repairLines(result: RepairResult, style: Style): string[] {
  const lines: string[] = []
  for (const repair of result.repairs) {
    lines.push(`${style.ok('✓')} line ${repair.line}: ${sanitize(repair.change)}`)
    lines.push(style.error(`    - ${sanitize(repair.before.trim())}`))
    lines.push(style.ok(`    + ${sanitize(repair.after.trim())}`))
    for (const now of repair.now) lines.push(style.dim(`    ${sanitize(now)}`))
  }
  const tried = `tried ${plural(result.tried, 'one-token change')}${result.exhausted ? '; the budget ran out' : ''}`
  lines.push(style.dim(tried))
  return lines
}

export function repair(
  io: CliIO,
  style: Style,
  loaded: Loaded,
  command: Extract<Command, { kind: 'repair' }>,
): ExitCode {
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const result = searchRepairs(recording, { kind: 'crash' })
  if (result.problem !== null) {
    const hint =
      recording.outcome.kind === 'error'
        ? ''
        : ' (for a wrong result, `hindsight debug` finds the function and tries repairs)'
    return fail(io, style, `${result.problem}${hint}`)
  }
  if (result.repairs.length === 0) {
    io.stdout(
      `No one-token change makes the run finish (${plural(result.tried, 'tried', 'tried')}).\n`,
    )
    return 1
  }
  io.stdout(
    `${style.bold('Repair previews')} (each makes the run finish; check that it is what you meant):\n`,
  )
  io.stdout(`${repairLines(result, style).join('\n')}\n`)
  return 0
}
