/**
 * `hindsight diff A B` and `hindsight diff FILE --set NAME=VALUE` (ARCHITECTURE §7.14, §9): record
 * two runs and compare what they did, call by call. Exit codes follow diff(1): 0 when the runs
 * behave the same, 1 when they differ, 2 for usage or compile trouble.
 */
import {
  type ChangedCall,
  compile,
  type DiffCall,
  diffRuns,
  type DiffList,
  type LineSpan,
  linesText,
  type OriginGroup,
  record,
  type Recording,
  type RunDiff,
  type UnmatchedCall,
  withInput,
} from '../core/index'
import type { Command } from './args'
import { type ExitCode, load, type Loaded } from './commands'
import { formatDiagnostic, makeStyle, sanitize, type Style } from './format'
import type { CliIO } from './io'
import { diffRows, outcomeText, rowLines } from './whatif'

export type DiffCommand = Extract<Command, { kind: 'diff' }>

const count = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

/** The two programs to run: B is the second file, or the first with an input changed. */
interface Sides {
  readonly a: Loaded
  readonly b: Loaded
  readonly header: string
  /** Where B's input was set: the top level's own change, shown with its origin. */
  readonly input: string | null
}

export function diffCommand(io: CliIO, command: DiffCommand): ExitCode {
  const style = makeStyle(io.color)
  const sides = loadSides(io, style, command)
  if (sides === null) return 2
  const options = { maxSteps: command.maxSteps, seed: command.seed }
  const a = record(sides.a.program, options)
  const b = record(sides.b.program, options)
  const diff = diffRuns(a, b, { limit: command.limit })
  const lines = [
    style.bold(sides.header),
    runLine('A', a, diff.a.calls),
    runLine('B', b, diff.b.calls),
    ...(diff.same ? [style.ok(sameText(diff))] : differenceLines(diff, sides.input, style)),
    ...budgetLines(diff, style),
  ]
  io.stdout(`${lines.join('\n')}\n`)
  return diff.same ? 0 : 1
}

function loadSides(io: CliIO, style: Style, command: DiffCommand): Sides | null {
  const a = load(io, style, command.fileA)
  if (a === null) return null
  if (command.set === null) {
    const b = load(io, style, command.fileB ?? '')
    if (b === null) return null
    return { a, b, header: `diff A = ${sanitize(a.file)}, B = ${sanitize(b.file)}`, input: null }
  }
  const { name, value } = command.set
  const input = withInput(a.source, name, value)
  if (!input.ok) {
    io.stderr(`${style.error('error')}: ${sanitize(input.error)}\n`)
    return null
  }
  const label = `${a.file} with ${name} = ${input.now}`
  const compiled = compile(input.source)
  if (!compiled.ok) {
    for (const diagnostic of compiled.diagnostics)
      io.stderr(`${formatDiagnostic(label, input.source, diagnostic, style)}\n\n`)
    return null
  }
  const b: Loaded = { file: label, source: input.source, program: compiled.program }
  const header = `diff ${sanitize(a.file)}: A as written, B with ${sanitize(name)} = ${sanitize(input.now)} (line ${input.line}; it was ${sanitize(input.was)})`
  return { a, b, header, input: `line ${input.line}, where ${name} is set` }
}

function runLine(label: string, recording: Recording, calls: number): string {
  return `${label}: ${count(recording.length)} steps, ${outcomeText(recording)}, ${plural(calls, 'call')}`
}

function sameText(diff: RunDiff): string {
  return `the runs behave the same: same outcome, same output, ${plural(diff.matched, 'matched call')}`
}

function differenceLines(diff: RunDiff, input: string | null, style: Style): string[] {
  return [
    ...outputLines(diff, style),
    ...unmatchedLines('calls only in A', '-', diff.onlyA, style),
    ...unmatchedLines('calls only in B', '+', diff.onlyB, style),
    ...diff.renamed.map((rename) =>
      style.dim(`renamed: ${sanitize(rename.from)} → ${sanitize(rename.to)}`),
    ),
    ...changedLines(diff.changed, style),
    ...originLines(diff, input, style),
  ]
}

function outputLines(diff: RunDiff, style: Style): string[] {
  const { removed, added, lines } = diff.output
  if (removed + added === 0) return [style.dim('the output is the same')]
  const head = `output: ${plural(removed, 'line')} only in A (-), ${count(added)} only in B (+)`
  return [head, ...diffRows(lines).flatMap((row) => rowLines(row, style))]
}

function more(list: DiffList<unknown>, style: Style): string[] {
  const rest = list.total - list.items.length
  return rest > 0 ? [style.dim(`  … ${count(rest)} more (raise --limit)`)] : []
}

function unmatchedLines(
  title: string,
  sign: string,
  list: DiffList<UnmatchedCall>,
  style: Style,
): string[] {
  if (list.total === 0) return []
  const paint = sign === '-' ? style.error : style.ok
  const rows = list.items.map((call) => {
    const inside = call.calls > 1 ? `, ${plural(call.calls - 1, 'call')} inside` : ''
    return `  ${paint(sign)} ${callText(call)}  ${style.dim(`step ${count(call.entry)}${inside}`)}`
  })
  return [`${title} (${count(list.total)}):`, ...rows, ...more(list, style)]
}

function callText(call: DiffCall): string {
  return sanitize(`${call.signature} ${call.did}`)
}

function nameOf(call: DiffCall): string {
  return call.depth === 0 ? 'the top-level code' : sanitize(call.name)
}

function pairLines(change: ChangedCall, style: Style): string[] {
  return [
    `    ${style.error('-')} ${callText(change.a)}  ${style.dim(`step ${count(change.a.entry)}`)}`,
    `    ${style.ok('+')} ${callText(change.b)}  ${style.dim(`step ${count(change.b.entry)}`)}`,
  ]
}

function changedLines(list: DiffList<ChangedCall>, style: Style): string[] {
  if (list.total === 0) return []
  const rows = list.items.flatMap((change) => {
    const inputs = change.inputsChanged ? style.dim(' (given other inputs)') : ''
    // The top level's output and outcome are shown above; its "finished" says nothing more.
    if (change.a.depth === 0) return [`  ${nameOf(change.a)} · ${change.changes.join(', ')}`]
    return [
      `  ${nameOf(change.a)} · ${change.changes.join(', ')}${inputs}`,
      ...pairLines(change, style),
    ]
  })
  return [`changed calls (${count(list.total)}):`, ...rows, ...more(list, style)]
}

function linesLabel(a: LineSpan | null, b: LineSpan | null): string {
  if (a === null || b === null) return ''
  const textA = linesText(a)
  const textB = linesText(b)
  return textA === textB ? ` (${textA})` : ` (${textA} in A, ${textB} in B)`
}

/** Why a call is an origin, as one clause. */
export function originReason(origin: OriginGroup): string {
  const calls = origin.changes.includes('calls')
  const behavior = origin.changes.some((aspect) => aspect !== 'calls')
  if (calls && !behavior) return 'given the same inputs, it makes calls the other run does not'
  if (calls) return 'given the same inputs, it behaves differently and makes different calls'
  if (origin.passesChanges) {
    return 'given the same inputs, it behaves differently and passes other values to the calls it makes'
  }
  return 'given the same inputs, it behaves differently while the calls it makes behave the same'
}

function originLines(diff: RunDiff, input: string | null, style: Style): string[] {
  const { origins } = diff
  if (origins.total === 0) {
    return [style.dim('no origin found: no call given the same inputs behaved differently')]
  }
  const rows = origins.items.flatMap((origin) => {
    const repeats = origin.count > 1 ? style.dim(` (${count(origin.count)} identical calls)`) : ''
    const top = input === null ? '' : ` (${sanitize(input)})`
    const lines = origin.a.depth === 0 ? top : linesLabel(origin.a.lines, origin.b.lines)
    const where = `${nameOf(origin.a)}${lines}`
    return [
      `  ${style.ok('✓')} ${style.bold(where)}: ${originReason(origin)}${repeats}`,
      ...(origin.a.depth === 0 ? [] : pairLines(origin, style)),
    ]
  })
  return [style.bold('the change starts in:'), ...rows, ...more(origins, style)]
}

function budgetLines(diff: RunDiff, style: Style): string[] {
  const notes: string[] = []
  if (diff.truncated.nodes) {
    notes.push(
      `aligned ${plural(diff.matched, 'matched call')}; the calls below them were not aligned`,
    )
  }
  if (diff.truncated.compared) {
    notes.push(`compared ${count(diff.compared)} of ${plural(diff.matched, 'matched call')}`)
  }
  return notes.map((note) => style.dim(note))
}
