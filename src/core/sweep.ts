/**
 * Parameter sweeps (ARCHITECTURE §7.13): one what-if per value. `start = 1..20` forks the run
 * twenty times at the same step, so the futures can be laid over each other and the inputs that
 * make a run explode stand out.
 */
import type {
  AsyncForkOptions,
  EditValue,
  ForkError,
  Recording,
  RecordingComparison,
  WriteTarget,
} from './api-types'
import { compareRecordings } from './compare'
import { parseLiteralValue } from './literal'

/** The most values one sweep takes. */
export const MAX_SWEEP_VALUES = 64

export type SweepValues =
  | { readonly ok: true; readonly values: readonly EditValue[] }
  | { readonly ok: false; readonly error: string }

const RANGE = /^(-?\d+(?:\.\d+)?)\s*\.\.=?\s*(-?\d+(?:\.\d+)?)(?:\s+step\s+(\d+(?:\.\d+)?))?$/

/** True when `text` asks for several values (a range or a comma list) rather than one literal. */
export function isSweepText(text: string): boolean {
  const source = text.trim()
  return RANGE.test(source) || (splitList(source)?.length ?? 0) > 1
}

/**
 * Reads the values of a sweep: `1..20` or `1..=20` (both ends included: twenty values),
 * `0..100 step 10`, `20..1` (downwards), a comma list of literals (`1, 27, "x", true`), or a
 * single literal.
 */
export function parseSweepValues(text: string): SweepValues {
  const source = text.trim()
  const range = RANGE.exec(source)
  if (range !== null) return rangeValues(Number(range[1]), Number(range[2]), range[3])
  const parts = splitList(source) ?? [source]
  if (parts.length > MAX_SWEEP_VALUES) return tooMany(parts.length)
  const values: EditValue[] = []
  for (const part of parts) {
    const literal = parseLiteralValue(part)
    if (!literal.ok) return { ok: false, error: literal.error }
    values.push(literal.value)
  }
  return { ok: true, values }
}

function tooMany(count: number): SweepValues {
  return {
    ok: false,
    error: `A sweep takes at most ${MAX_SWEEP_VALUES} values (that is ${count.toLocaleString('en-US')}); add a step, like 1..1000 step 50`,
  }
}

function rangeValues(from: number, to: number, stepText: string | undefined): SweepValues {
  const size = stepText === undefined ? 1 : Number(stepText)
  if (!(size > 0)) return { ok: false, error: 'The step of a sweep must be above 0' }
  const count = Math.floor(Math.abs(to - from) / size + 1e-9) + 1
  if (count > MAX_SWEEP_VALUES) return tooMany(count)
  const direction = to >= from ? 1 : -1
  const values: number[] = []
  // Multiplying (not adding up) keeps 0.1-sized steps from drifting.
  for (let i = 0; i < count; i++) values.push(Number((from + direction * i * size).toPrecision(12)))
  return { ok: true, values }
}

/** The items of a top-level comma list, or null when a quoted string makes that unsafe to tell. */
function splitList(source: string): string[] | null {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (ch === '\\' && quoted) {
      current += ch + (source[++i] ?? '')
      continue
    }
    if (ch === '"') quoted = !quoted
    if (ch === ',' && !quoted) {
      parts.push(current.trim())
      current = ''
    } else current += ch
  }
  if (quoted) return null
  parts.push(current.trim())
  return parts.every((part) => part !== '') ? parts : null
}

export interface SweepRun {
  readonly value: EditValue
  readonly recording: Recording
  /** Against the run that was swept. */
  readonly comparison: RecordingComparison
  /** The deepest call depth the run reached. */
  readonly maxDepth: number
}

export interface SweepResult {
  /** One run per value that could be forked, in the order given. */
  readonly runs: readonly SweepRun[]
  /** The values that could not be forked, with the reason. */
  readonly failed: readonly { readonly value: EditValue; readonly error: ForkError }[]
}

function runOf(base: Recording, value: EditValue, recording: Recording): SweepRun {
  let maxDepth = 0
  for (const depth of recording.depthSeries()) if (depth > maxDepth) maxDepth = depth
  return { value, recording, comparison: compareRecordings(base, recording), maxDepth }
}

/** Forks `recording` at `time` once per value, each with `target` set to it. */
export function sweep(
  recording: Recording,
  time: number,
  target: WriteTarget,
  values: readonly EditValue[],
): SweepResult {
  const runs: SweepRun[] = []
  const failed: { value: EditValue; error: ForkError }[] = []
  for (const value of values.slice(0, MAX_SWEEP_VALUES)) {
    const fork = recording.fork(time, { target, value })
    if (fork.ok) runs.push(runOf(recording, value, fork.recording))
    else failed.push({ value, error: fork.error })
  }
  return { runs, failed }
}

/** `sweep` in slices; an aborted signal ends it with the runs finished so far. */
export async function sweepAsync(
  recording: Recording,
  time: number,
  target: WriteTarget,
  values: readonly EditValue[],
  options: Pick<AsyncForkOptions, 'signal' | 'sliceMs'> & {
    readonly onRun?: (done: number, total: number) => void
  } = {},
): Promise<SweepResult> {
  const runs: SweepRun[] = []
  const failed: { value: EditValue; error: ForkError }[] = []
  const wanted = values.slice(0, MAX_SWEEP_VALUES)
  // Read afresh each time: the signal changes while a fork is awaited.
  const aborted = (): boolean => options.signal?.aborted === true
  for (const value of wanted) {
    if (aborted()) break
    const fork = await recording.forkAsync(time, { target, value }, options)
    if (aborted()) break
    if (fork.ok) runs.push(runOf(recording, value, fork.recording))
    else failed.push({ value, error: fork.error })
    options.onRun?.(runs.length + failed.length, wanted.length)
  }
  return { runs, failed }
}
