/**
 * Runs as plain data (ARCHITECTURE §11.7): `describeRun` says how a recording the studio shows
 * was made, `recreateRun` records it again from that description. A what-if fork carries its whole chain of edits (`Recording.whatIf.edits`), and a
 * fork of a fork is reproduced by forking the real run once per edit in time order.
 */
import {
  compile,
  DEFAULT_SEED,
  record,
  type Recording,
  type ScheduleOptions,
} from '../../core/index'
import type { RunDescription } from './protocol'

const descriptions = new WeakMap<Recording, RunDescription | null>()
/** The recording each description was made from (on the thread that made it). */
const described = new WeakMap<RunDescription, Recording>()
const keys = new WeakMap<RunDescription, string>()

/**
 * The description of `recording`, or null when it cannot be reproduced exactly (a run the user
 * stopped). The step limit and seed are the ones the run was recorded with: forks inherit the
 * limit of the run they fork, so the analyses' own forks (sweeps, repairs, the inverse what-if)
 * stop where the studio's would.
 */
export function describeRun(recording: Recording): RunDescription | null {
  let description = descriptions.get(recording)
  if (description === undefined) {
    description = describe(recording)
    descriptions.set(recording, description)
    if (description !== null) described.set(description, recording)
  }
  return description
}

/**
 * The recording `run` describes: the one it was made from when this thread made it (the
 * main-thread fallback), else recorded again; null when that fails.
 */
export function recordingOf(run: RunDescription): Recording | null {
  const known = described.get(run)
  if (known !== undefined) return known
  const made = recreateRun(run)
  return made.ok ? made.recording : null
}

/** What a recording of the core's `Recording` class keeps of how it was made. */
interface RecordedWith {
  readonly core?: {
    readonly maxSteps?: unknown
    readonly seed?: unknown
    readonly taskSchedule?: ScheduleOptions
  }
}

function describe(recording: Recording): RunDescription | null {
  const { outcome, length } = recording
  if (outcome.kind === 'aborted') return null
  const edits = recording.whatIf?.edits ?? []
  const made = (recording as RecordedWith).core
  const seed = typeof made?.seed === 'number' ? made.seed : DEFAULT_SEED
  const lastEdit = edits.reduce((latest, edit) => Math.max(latest, edit.time), -1)
  // Without the recorded limit (a stand-in recording), any limit beyond the end repeats the run.
  const fallback =
    outcome.kind === 'step-limit' ? outcome.maxSteps : Math.max(length + 1, lastEdit + 1)
  const maxSteps = typeof made?.maxSteps === 'number' ? made.maxSteps : fallback
  const description: RunDescription = {
    source: recording.program.source,
    seed,
    maxSteps,
    edits,
    length,
    outcome: outcome.kind,
  }
  const schedule = made?.taskSchedule
  return schedule === undefined ? description : { ...description, schedule }
}

/** A string that is equal for equal descriptions (cached per description). */
export function runKey(run: RunDescription): string {
  let key = keys.get(run)
  if (key === undefined) {
    key = JSON.stringify(run)
    keys.set(run, key)
  }
  return key
}

export type Recreated =
  | { readonly ok: true; readonly recording: Recording }
  | { readonly ok: false; readonly error: string }

/** Records the described run again; an error when that is impossible or gives another run. */
export function recreateRun(run: RunDescription): Recreated {
  const compiled = compile(run.source)
  if (!compiled.ok) return { ok: false, error: 'The program does not compile.' }
  let recording = record(compiled.program, {
    maxSteps: run.maxSteps,
    seed: run.seed,
    schedule: run.schedule,
  })
  for (const { time, edit } of run.edits) {
    const fork = recording.fork(time, edit, { maxSteps: run.maxSteps })
    if (!fork.ok)
      return { ok: false, error: `The what-if could not be repeated: ${fork.error.message}` }
    recording = fork.recording
  }
  if (recording.length !== run.length || recording.outcome.kind !== run.outcome) {
    return { ok: false, error: 'Recording the run again gave a different run.' }
  }
  return { ok: true, recording }
}
