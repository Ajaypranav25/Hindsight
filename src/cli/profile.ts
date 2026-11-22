/**
 * `hindsight profile` (ARCHITECTURE §7.16, §9): where a run spent its steps, per function (inclusive
 * and exclusive steps, calls, average and largest call), per line, or as folded stacks for flame
 * graph tools. Library code is folded into the user calls that made it (just-my-code).
 */
import { foldedText, LineIndex, type Outcome, profile, record } from '../core/index'
import type { Command } from './args'
import type { ExitCode, Loaded } from './commands'
import { sanitize, type Style } from './format'
import type { CliIO } from './io'

const count = (n: number) => n.toLocaleString('en-US')

/** A share of the run as a percentage with one decimal. */
export function percent(part: number, whole: number): string {
  return whole === 0 ? '0.0 %' : `${((100 * part) / whole).toFixed(1)} %`
}

/** How the run ended, when it did not finish (the profile covers the steps that ran). */
export function outcomeNote(outcome: Outcome): string | null {
  switch (outcome.kind) {
    case 'finished':
      return null
    case 'error':
      return `the run stopped with a runtime error (${outcome.error.code}): the profile covers the steps before it`
    case 'step-limit':
      return `the run reached the step limit of ${count(outcome.maxSteps)}: the profile covers those steps (raise --max-steps)`
    case 'aborted':
      return 'the run was stopped early'
  }
}

export function profileCommand(
  io: CliIO,
  style: Style,
  loaded: Loaded,
  command: Extract<Command, { kind: 'profile' }>,
): ExitCode {
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const result = profile(recording, { justMyCode: true, lines: command.lines })
  if (command.folded) {
    io.stdout(`${sanitize(foldedText(result.folded))}\n`)
    return 0
  }
  const out: string[] = [
    style.bold(`${count(result.steps)} steps`) +
      style.dim(
        ` · ${count(result.functions.length)} functions · library code folded into its callers`,
      ),
  ]
  const note = outcomeNote(recording.outcome)
  if (note !== null) out.push(style.dim(note))
  out.push('', ...functionRows(result.functions.slice(0, command.top), result.steps, style))
  const hidden = result.functions.length - command.top
  if (hidden > 0) out.push(style.dim(`  … ${count(hidden)} more (raise --top)`))
  if (command.lines) {
    out.push('', ...lineRows(result.lines.slice(0, command.top), result.steps, loaded, style))
    const more = result.lines.length - command.top
    if (more > 0) out.push(style.dim(`  … ${count(more)} more lines (raise --top)`))
  }
  io.stdout(`${out.join('\n')}\n`)
  return 0
}

interface Row {
  readonly label: string
  readonly lines: { readonly start: number } | null
  readonly inclusive: number
  readonly exclusive: number
  readonly calls: number
  readonly average: number
  readonly max: number
}

function functionRows(rows: readonly Row[], steps: number, style: Style): string[] {
  const head = ['inclusive', 'share', 'exclusive', 'calls', 'avg/call', 'max/call']
  const cells = rows.map((row) => [
    count(row.inclusive),
    percent(row.inclusive, steps),
    count(row.exclusive),
    count(row.calls),
    count(Math.round(row.average)),
    count(row.max),
  ])
  const widths = head.map((title, k) =>
    Math.max(title.length, ...cells.map((cell) => cell[k]!.length)),
  )
  const line = (values: readonly string[]) =>
    values.map((value, k) => value.padStart(widths[k]!)).join('  ')
  return [
    style.dim(`${line(head)}  function`),
    ...rows.map((row, i) => {
      const where =
        row.lines === null
          ? style.dim(' (library)')
          : row.label === '<top level>' || row.label.startsWith('lambda@')
            ? ''
            : style.dim(` (line ${row.lines.start})`)
      return `${line(cells[i]!)}  ${sanitize(row.label)}${where}`
    }),
  ]
}

function lineRows(
  rows: readonly { readonly line: number; readonly steps: number }[],
  steps: number,
  loaded: Loaded,
  style: Style,
): string[] {
  const index = new LineIndex(loaded.source)
  const stepWidth = Math.max(5, ...rows.map((row) => count(row.steps).length))
  const lineWidth = Math.max(4, ...rows.map((row) => String(row.line).length))
  return [
    style.dim(`${'steps'.padStart(stepWidth)}    share  ${'line'.padStart(lineWidth)}`),
    ...rows.map((row) => {
      const text = sanitize(index.lineText(row.line).replace(/\t/g, ' ').trim())
      return `${count(row.steps).padStart(stepWidth)}  ${percent(row.steps, steps).padStart(7)}  ${String(row.line).padStart(lineWidth)} | ${text}`
    }),
  ]
}
