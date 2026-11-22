/**
 * Trace files as recordings (ARCHITECTURE §7.15): `traceBundle` describes a recording (and its
 * what-if chain) as a `TraceBundle`; `replayTrace` and `replayTraceAsync` record the bundle's
 * program again, re-apply its what-if edits and check the result against the saved fingerprint.
 * They take the compile and record functions as dependencies, as `repairSearch` does, so the
 * studio can pass its own engine.
 */
import {
  type AsyncRecordOptions,
  type CompileResult,
  DEFAULT_MAX_STEPS,
  DEFAULT_SEED,
  type ForkResult,
  type Outcome,
  type RecordOptions,
  type Recording,
  type ScheduleOptions,
} from './api-types'
import type { Program } from './bytecode'
import { replayAccess } from './recorder'
import { LineIndex } from './span'
import { normalSchedule } from './tasks-info'
import {
  MAX_TRACE_SOURCE_LENGTH,
  MAX_TRACE_STEPS,
  TRACE_FORMAT,
  TRACE_FORMAT_VERSION,
  type TraceBundle,
  type TraceOutcome,
} from './trace-file'
import { fingerprintRecording, firstDifference, type StepWindow } from './trace-hash'

export interface TraceBundleInput {
  /** The run on display: a real run or a what-if fork. */
  readonly recording: Recording
  /** The real run behind a what-if (its step limit is the bundle's `maxSteps`). */
  readonly base?: Recording | null
  /** The pen, clamped to `0..recording.length`. */
  readonly time: number
  readonly hindsightVersion: string
  readonly title?: string | null
}

export type TraceBundleResult =
  | { readonly ok: true; readonly bundle: TraceBundle }
  | { readonly ok: false; readonly error: string }

/** The step limit a recording ran under; an aborted run counts as paused where it stopped. */
function stepLimitOf(recording: Recording): number {
  if (recording.outcome.kind === 'aborted') return recording.length
  if (recording.outcome.kind === 'step-limit') return recording.outcome.maxSteps
  return replayAccess(recording)?.core.maxSteps ?? DEFAULT_MAX_STEPS
}

function traceOutcome(outcome: Outcome, source: string): TraceOutcome {
  if (outcome.kind !== 'error') return outcome
  const { code, message, span } = outcome.error
  return { kind: 'error', code, message, line: new LineIndex(source).lineOf(span.start) }
}

/** A trace bundle for `input.recording`, or why it cannot be saved. */
export function traceBundle(input: TraceBundleInput): TraceBundleResult {
  const { recording } = input
  const source = recording.program.source
  if (source.length > MAX_TRACE_SOURCE_LENGTH)
    return { ok: false, error: 'the program is too long to save as a trace' }
  const base = recording.whatIf === null ? recording : (input.base ?? recording)
  const maxSteps = stepLimitOf(base)
  const forkMaxSteps = recording.whatIf === null ? null : stepLimitOf(recording)
  if (Math.max(maxSteps, forkMaxSteps ?? 0) > MAX_TRACE_STEPS)
    return {
      ok: false,
      error: `runs over ${MAX_TRACE_STEPS.toLocaleString('en-US')} steps cannot be saved as a trace`,
    }
  const { fingerprint, checkpoints } = fingerprintRecording(recording)
  const time = Math.max(0, Math.min(recording.length, Math.round(input.time) || 0))
  const bundle: TraceBundle = {
    format: TRACE_FORMAT,
    version: TRACE_FORMAT_VERSION,
    hindsightVersion: input.hindsightVersion,
    title: input.title ?? null,
    source,
    seed: replayAccess(recording)?.core.seed ?? DEFAULT_SEED,
    ...scheduleField(normalSchedule(replayAccess(recording)?.core.taskSchedule)),
    maxSteps,
    edits: recording.whatIf?.edits ?? [],
    forkMaxSteps,
    time,
    outcome: traceOutcome(recording.outcome, source),
    length: recording.length,
    output: recording.outputs.map((event) => event.text),
    fingerprint,
    checkpoints,
  }
  return { ok: true, bundle }
}

/** Whether a replay did what the saved trace says. */
export type TraceVerification =
  | { readonly verified: true }
  | {
      readonly verified: false
      /** A sentence: where and why the replay differs. */
      readonly message: string
      /** Where the replay first differs, when it got far enough to compare. */
      readonly firstDifference: StepWindow | null
    }

function windowText(window: StepWindow): string {
  return window.to - window.from === 1
    ? `from step ${window.from.toLocaleString('en-US')}`
    : `somewhere in steps ${window.from.toLocaleString('en-US')} to ${(window.to - 1).toLocaleString('en-US')}`
}

/** Compares a replay of `bundle` with the run the bundle was saved from. */
export function verifyTrace(bundle: TraceBundle, recording: Recording): TraceVerification {
  const replay = fingerprintRecording(recording, bundle.checkpoints.stride)
  const difference = firstDifference(bundle, replay, recording.length)
  if (difference === null) return { verified: true }
  return {
    verified: false,
    message: `This run replays differently than when it was saved (with Hindsight ${bundle.hindsightVersion}): it differs ${windowText(difference)}.`,
    firstDifference: difference,
  }
}

export interface TraceDeps {
  compile(source: string): CompileResult
  record(program: Program, options: RecordOptions): Recording
}

export interface AsyncTraceDeps {
  compile(source: string): CompileResult
  recordAsync(program: Program, options: AsyncRecordOptions): Promise<Recording>
}

export type TraceReplayErrorCode = 'compile' | 'aborted'

export type TraceReplay =
  | {
      readonly ok: true
      /** The real run. */
      readonly base: Recording
      /** The run with every edit that could be re-applied (the base when there are none). */
      readonly recording: Recording
      /** The saved pen, clamped to `recording`. */
      readonly time: number
      readonly verification: TraceVerification
    }
  | { readonly ok: false; readonly code: TraceReplayErrorCode; readonly error: string }

function compileFailure(result: CompileResult): TraceReplay {
  const first = result.diagnostics[0]
  const detail = first === undefined ? '' : `: ${first.code} ${first.message}`
  return {
    ok: false,
    code: 'compile',
    error: `the program in this trace does not compile${detail}`,
  }
}

/** The result once the edits have been applied as far as they go. */
function replayed(
  bundle: TraceBundle,
  base: Recording,
  recording: Recording,
  failed: { readonly index: number; readonly result: ForkResult & { ok: false } } | null,
): TraceReplay {
  const time = Math.min(bundle.time, recording.length)
  if (failed === null)
    return { ok: true, base, recording, time, verification: verifyTrace(bundle, recording) }
  const message = `This run replays differently than when it was saved (with Hindsight ${bundle.hindsightVersion}): what-if edit ${failed.index + 1} of ${bundle.edits.length} could not be applied again (${failed.result.error.message}).`
  return {
    ok: true,
    base,
    recording,
    time,
    verification: { verified: false, message, firstDifference: null },
  }
}

/** `{schedule}` when there is one: a round-robin bundle carries no field. */
function scheduleField(schedule: ScheduleOptions | undefined): { schedule?: ScheduleOptions } {
  return schedule === undefined ? {} : { schedule }
}

function forkOptions(bundle: TraceBundle): { maxSteps?: number } {
  return bundle.forkMaxSteps === null ? {} : { maxSteps: bundle.forkMaxSteps }
}

/** Records the bundle's program again, re-applies its what-if edits and verifies the result. */
export function replayTrace(deps: TraceDeps, bundle: TraceBundle): TraceReplay {
  const compiled = deps.compile(bundle.source)
  if (!compiled.ok) return compileFailure(compiled)
  const base = deps.record(compiled.program, {
    maxSteps: bundle.maxSteps,
    seed: bundle.seed,
    schedule: bundle.schedule,
  })
  let recording = base
  for (const [index, timed] of bundle.edits.entries()) {
    const result = recording.fork(timed.time, timed.edit, forkOptions(bundle))
    if (!result.ok) return replayed(bundle, base, recording, { index, result })
    recording = result.recording
  }
  return replayed(bundle, base, recording, null)
}

export interface TraceReplayOptions {
  readonly signal?: AsyncRecordOptions['signal']
  readonly onProgress?: AsyncRecordOptions['onProgress']
  readonly sliceMs?: number
}

const ABORTED: TraceReplay = { ok: false, code: 'aborted', error: 'opening the trace was stopped' }

/** `replayTrace` in slices (`recordAsync`, `forkAsync`); a set `signal` stops it. */
export async function replayTraceAsync(
  deps: AsyncTraceDeps,
  bundle: TraceBundle,
  options: TraceReplayOptions = {},
): Promise<TraceReplay> {
  const compiled = deps.compile(bundle.source)
  if (!compiled.ok) return compileFailure(compiled)
  const { signal, onProgress, sliceMs } = options
  const slicing = { signal, onProgress, sliceMs }
  const base = await deps.recordAsync(compiled.program, {
    maxSteps: bundle.maxSteps,
    seed: bundle.seed,
    schedule: bundle.schedule,
    ...slicing,
  })
  if (signal?.aborted) return ABORTED
  let recording = base
  for (const [index, timed] of bundle.edits.entries()) {
    const result = await recording.forkAsync(timed.time, timed.edit, {
      ...forkOptions(bundle),
      ...slicing,
    })
    if (signal?.aborted) return ABORTED
    if (!result.ok) return replayed(bundle, base, recording, { index, result })
    recording = result.recording
  }
  return replayed(bundle, base, recording, null)
}

export type TraceOpenResult =
  | (Extract<TraceReplay, { readonly ok: true }> & { readonly bundle: TraceBundle })
  | {
      readonly ok: false
      /** `format`: the bytes are not a valid trace file. */
      readonly code: TraceReplayErrorCode | 'format'
      readonly error: string
    }

/** A replay with the bundle it came from. */
export function openedTrace(bundle: TraceBundle, replay: TraceReplay): TraceOpenResult {
  return replay.ok ? { ...replay, bundle } : replay
}
