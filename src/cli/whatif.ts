/**
 * `hindsight whatif FILE --at T --set NAME=VALUE` (ARCHITECTURE §7.5, §9): record the program, fork
 * it at step T with NAME set to VALUE, and print where the futures diverge and how the output
 * changes ("-" the real run, "+" the what-if).
 */
import type {
  OutputDiffLine,
  Program,
  Recording,
  RecordingComparison,
  StateView,
  ValueView,
  WriteTarget,
} from '../core/index'
import { compareRecordings, formatLiteral, LineIndex, record, sweep } from '../core/index'
import type { Command } from './args'
import { formatValueView, sanitize, type Style } from './format'
import type { CliIO } from './io'

type WhatIfCommand = Extract<Command, { kind: 'whatif' }>

/** Unchanged output lines kept around each change; longer unchanged runs are summarized. */
export const DIFF_CONTEXT = 3

interface Variable {
  readonly target: WriteTarget
  readonly value: ValueView
}

const count = (n: number) => n.toLocaleString('en-US')

export function whatIf(
  io: CliIO,
  style: Style,
  loaded: { readonly source: string; readonly program: Program },
  command: WhatIfCommand,
): 0 | 1 {
  const fail = (message: string): 1 => {
    io.stderr(`${style.error('error')}: ${sanitize(message)}\n`)
    return 1
  }
  const real = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  if (command.at >= real.length) {
    return fail(
      `step ${count(command.at)} is not before the end of the run (${count(real.length)})`,
    )
  }
  const variable = visibleVariable(real.stateAt(command.at), command.name)
  if (variable === null) {
    return fail(`no variable named '${command.name}' is visible at step ${count(command.at)}`)
  }
  if (command.values.length > 1) {
    io.stdout(`${sweepLines(real, variable, command, style).join('\n')}\n`)
    return 0
  }
  const result = real.fork(command.at, { target: variable.target, value: command.value })
  if (!result.ok) return fail(result.error.message)
  const fork = result.recording
  const comparison = compareRecordings(real, fork)
  const edit = `${command.name} = ${formatLiteral(command.value)}`
  const lines = [
    `${style.bold(`what if ${sanitize(edit)}`)} at step ${count(command.at)} ${style.dim(`(it was ${formatValueView(variable.value)})`)}`,
    divergenceLine(fork, comparison, loaded.source, style),
    `real run: ${count(real.length)} steps, ${outcomeText(real)}`,
    `what if:  ${count(fork.length)} steps, ${outcomeText(fork)}`,
    ...outputLines(comparison, style),
  ]
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}

/** A sweep: one what-if per value, one row each (ARCHITECTURE §7.13). */
function sweepLines(
  real: Recording,
  variable: Variable,
  command: WhatIfCommand,
  style: Style,
): string[] {
  const { runs, failed } = sweep(real, command.at, variable.target, command.values)
  const head = `${style.bold(`what if ${sanitize(command.name)} =`)} ${count(command.values.length)} values at step ${count(command.at)} ${style.dim(`(it was ${formatValueView(variable.value)}; the real run takes ${count(real.length)} steps)`)}`
  const rows = runs.map((run) => {
    const { removed, added } = run.comparison
    const output =
      removed + added === 0 ? 'same output' : `output -${count(removed)} +${count(added)}`
    const value = sanitize(formatLiteral(run.value)).padEnd(10)
    const steps = `${count(run.recording.length)} steps`.padEnd(16)
    const depth = `depth ${count(run.maxDepth)}`.padEnd(10)
    return `  ${value} ${steps} ${depth} ${outcomeText(run.recording)} · ${output}`
  })
  const most = runs.reduce((a, b) => (b.recording.length > a.recording.length ? b : a), runs[0])
  const errors = failed.map(
    (entry) =>
      `  ${sanitize(formatLiteral(entry.value)).padEnd(10)} ${style.error(sanitize(entry.error.message))}`,
  )
  const longest =
    most === undefined || runs.length < 2
      ? []
      : [
          style.dim(
            `longest: ${sanitize(command.name)} = ${sanitize(formatLiteral(most.value))} (${count(most.recording.length)} steps)`,
          ),
        ]
  return [head, ...rows, ...errors, ...longest]
}

/** The variable `name` in the innermost frame at the pen: its locals, captures, then globals. */
export function visibleVariable(view: StateView, name: string): Variable | null {
  const frame = view.frames.at(-1)
  const local = frame?.locals.findLast((candidate) => candidate.name === name)
  const capture = frame?.captures.find((candidate) => candidate.name === name)
  const global = view.globals.find((candidate) => candidate.name === name)
  return local ?? capture ?? global ?? null
}

function divergenceLine(
  fork: Recording,
  comparison: RecordingComparison,
  source: string,
  style: Style,
): string {
  const step = comparison.divergence
  if (step === null) return style.dim('the futures do not diverge: the run is unchanged')
  const location = fork.locationAt(step)
  if (location?.source !== 'main') return `the futures diverge at step ${count(step)}`
  const { line, col } = new LineIndex(source).lineCol(location.span.start)
  return `the futures diverge at step ${count(step)} · line ${line}, column ${col} · in ${sanitize(location.functionName)}`
}

function outcomeText(recording: Recording): string {
  const outcome = recording.outcome
  if (outcome.kind === 'error') {
    return `ends with ${outcome.error.code}: ${sanitize(outcome.error.message)}`
  }
  return outcome.kind === 'finished' ? 'finishes normally' : 'stops at the step limit'
}

function outputLines(comparison: RecordingComparison, style: Style): string[] {
  const { removed, added } = comparison
  if (removed + added === 0) return [style.dim('the output is the same')]
  const head = `output: ${count(removed)} ${removed === 1 ? 'line' : 'lines'} only in the real run (-), ${count(added)} only in the what-if (+)`
  return [head, ...diffRows(comparison.lines).flatMap((row) => rowLines(row, style))]
}

/** The diff with long unchanged runs replaced by their length. */
export function diffRows(lines: readonly OutputDiffLine[]): (OutputDiffLine | number)[] {
  const rows: (OutputDiffLine | number)[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.kind !== 'same') {
      rows.push(lines[i++]!)
      continue
    }
    let j = i
    while (j < lines.length && lines[j]!.kind === 'same') j++
    const head = i === 0 ? 0 : DIFF_CONTEXT
    const tail = j === lines.length ? 0 : DIFF_CONTEXT
    if (j - i <= head + tail + 1) rows.push(...lines.slice(i, j))
    else rows.push(...lines.slice(i, i + head), j - i - head - tail, ...lines.slice(j - tail, j))
    i = j
  }
  return rows
}

function rowLines(row: OutputDiffLine | number, style: Style): string[] {
  if (typeof row === 'number') return [style.dim(` … ${count(row)} unchanged lines`)]
  const sign = row.kind === 'same' ? ' ' : row.kind === 'removed' ? '-' : '+'
  const paint = row.kind === 'same' ? String : row.kind === 'removed' ? style.error : style.ok
  return sanitize(row.text)
    .split('\n')
    .map((text) => paint(`${sign}${text}`))
}
