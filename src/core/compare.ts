/**
 * Comparing two runs of one program (ARCHITECTURE §7.5), typically the real run and a what-if: the
 * first step where they diverge, and a longest-common-subsequence diff of their output lines.
 */
import type {
  OutputDiffLine,
  OutputEvent,
  Recording,
  RecordingComparison,
  TimedEdit,
} from './api-types'
import { InternalError } from './diagnostics'
import { recordingCore } from './recorder'
import type { RecordingCore } from './recorder-session'

/** Above this many line pairs (after trimming the common ends) a diff is not minimized. */
export const MAX_DIFF_CELLS = 1_000_000

export function compareRecordings(a: Recording, b: Recording): RecordingComparison {
  if (a.program !== b.program) {
    throw new InternalError('compareRecordings needs two recordings of the same program')
  }
  const divergence = firstDivergence(new Cursor(a), new Cursor(b))
  const lines = diffOutputs(a.outputs, b.outputs)
  const removed = lines.filter((line) => line.kind === 'removed').length
  const added = lines.filter((line) => line.kind === 'added').length
  return { divergence, lines, removed, added }
}

/** Reads one recording's events and output step by step, skipping what-if edit events. */
class Cursor {
  readonly core: RecordingCore
  row = 0
  output = 0
  private readonly editRows: ReadonlySet<number>

  constructor(recording: Recording) {
    const core = recordingCore(recording)
    if (core === null) throw new InternalError('compareRecordings needs recordings made by record')
    this.core = core
    this.editRows = editRows(core, recording.whatIf?.edits ?? [])
  }

  /** True when an event other than an edit happens at `t` (the cursor stops on it). */
  eventAt(t: number): boolean {
    const { events, eventCount } = this.core
    while (this.row < eventCount && events.times[this.row] === t && this.editRows.has(this.row)) {
      this.row++
    }
    return this.row < eventCount && events.times[this.row] === t
  }

  outputAt(t: number): boolean {
    const outputs = this.core.outputs
    return this.output < outputs.length && outputs[this.output]!.time === t
  }
}

/** The event rows of the edits: the first rows at each edit's step. */
function editRows(core: RecordingCore, edits: readonly TimedEdit[]): Set<number> {
  const rows = new Set<number>()
  let previous = -1
  let next = 0
  for (const { time } of edits) {
    if (time !== previous) next = core.events.firstRowAt(time, core.eventCount)
    previous = time
    rows.add(next++)
  }
  return rows
}

function firstDivergence(a: Cursor, b: Cursor): number | null {
  const n = Math.min(a.core.length, b.core.length)
  const sa = a.core.steps
  const sb = b.core.steps
  for (let t = 0; t < n; t++) {
    const sameStep =
      sa.protoIds[t] === sb.protoIds[t] && sa.ips[t] === sb.ips[t] && sa.depths[t] === sb.depths[t]
    if (!sameStep || !sameEvents(a, b, t) || !sameOutputs(a, b, t)) return t
  }
  return a.core.length === b.core.length && sameEnd(a.core, b.core) ? null : n
}

function sameEvents(a: Cursor, b: Cursor, t: number): boolean {
  for (;;) {
    const moreA = a.eventAt(t)
    const moreB = b.eventAt(t)
    if (!moreA || !moreB) return moreA === moreB
    if (!a.core.events.sameRow(a.row, b.core.events, b.row)) return false
    a.row++
    b.row++
  }
}

function sameOutputs(a: Cursor, b: Cursor, t: number): boolean {
  for (;;) {
    const moreA = a.outputAt(t)
    const moreB = b.outputAt(t)
    if (!moreA || !moreB) return moreA === moreB
    if (a.core.outputs[a.output]!.text !== b.core.outputs[b.output]!.text) return false
    a.output++
    b.output++
  }
}

function sameEnd(a: RecordingCore, b: RecordingCore): boolean {
  const x = a.outcome
  const y = b.outcome
  if (x.kind !== y.kind) return false
  if (x.kind === 'error' && y.kind === 'error' && x.error.message !== y.error.message) return false
  const ea = a.end
  const eb = b.end
  if (ea === null || eb === null) return ea === eb
  return ea.protoId === eb.protoId && ea.ip === eb.ip && ea.depth === eb.depth
}

// ---------------------------------------------------------------------------------------------
// Output diff

/**
 * Both runs' output lines in order, marked same, removed (only in `a`) or added (only in `b`).
 * The common ends are trimmed first; a middle of more than `maxCells` line pairs is reported as
 * all removed, then all added, rather than minimized.
 */
export function diffOutputs(
  a: readonly OutputEvent[],
  b: readonly OutputEvent[],
  maxCells: number = MAX_DIFF_CELLS,
): OutputDiffLine[] {
  let start = 0
  while (start < a.length && start < b.length && a[start]!.text === b[start]!.text) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1]!.text === b[endB - 1]!.text) {
    endA--
    endB--
  }
  const lines: OutputDiffLine[] = []
  for (let i = 0; i < start; i++) lines.push(same(a, b, i, i))
  const n = endA - start
  const m = endB - start
  if (n * m > maxCells) {
    for (let i = start; i < endA; i++) lines.push(removed(a, i))
    for (let j = start; j < endB; j++) lines.push(added(b, j))
  } else {
    diffMiddle(a.slice(start, endA), b.slice(start, endB), start, lines)
  }
  for (let k = 0; endA + k < a.length; k++) lines.push(same(a, b, endA + k, endB + k))
  return lines
}

/** An LCS diff of `a` and `b` (which start at index `offset` of the full lists). */
function diffMiddle(
  a: readonly OutputEvent[],
  b: readonly OutputEvent[],
  offset: number,
  lines: OutputDiffLine[],
): void {
  const n = a.length
  const m = b.length
  const width = m + 1
  // lcs[i * width + j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i]!.text === b[j]!.text
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.text === b[j]!.text) {
      lines.push(line('same', a[i]!.text, offset + i, offset + j, a[i]!.time, b[j]!.time))
      i++
      j++
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      lines.push(line('removed', a[i]!.text, offset + i, null, a[i]!.time, null))
      i++
    } else {
      lines.push(line('added', b[j]!.text, null, offset + j, null, b[j]!.time))
      j++
    }
  }
}

function same(a: readonly OutputEvent[], b: readonly OutputEvent[], i: number, j: number) {
  return line('same', a[i]!.text, i, j, a[i]!.time, b[j]!.time)
}

function removed(a: readonly OutputEvent[], i: number): OutputDiffLine {
  return line('removed', a[i]!.text, i, null, a[i]!.time, null)
}

function added(b: readonly OutputEvent[], j: number): OutputDiffLine {
  return line('added', b[j]!.text, null, j, null, b[j]!.time)
}

function line(
  kind: OutputDiffLine['kind'],
  text: string,
  indexA: number | null,
  indexB: number | null,
  timeA: number | null,
  timeB: number | null,
): OutputDiffLine {
  return { kind, text, indexA, indexB, timeA, timeB }
}
