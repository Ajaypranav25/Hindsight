/**
 * Where the pen goes when an edited program has been recorded again (ARCHITECTURE §11.3): with
 * "Keep my place after edits", to the same moment of the new run (`mapMoment`: the call that was
 * running, found through the call-tree alignment, and in it the same run of the same line);
 * otherwise, or when either run is too long to align quickly, the same step number. A pen at the
 * end stays at the end. Pure functions over the engine.
 */
import type { MomentPrecision, Recording } from '../../core/index'
import type { EditRun, Engine } from './types'

/** Runs longer than this keep the step number (aligning them could hold up the display). */
export const KEEP_PLACE_MAX_STEPS = 2_000_000

export interface KeptPlace {
  readonly time: number
  /** How the moment was found, when it was mapped (null: the step number was kept). */
  readonly place: { readonly call: string; readonly precision: MomentPrecision } | null
}

/** The pen in `recording` (the run after an edit) for the pen at `time` in `previous`. */
export function keptPlace(
  engine: Pick<Engine, 'mapMoment'>,
  previous: Recording | null,
  time: number,
  recording: Recording,
  keepPlace: boolean,
): KeptPlace {
  if (previous === null) return { time: 0, place: null }
  if (time >= previous.length) return { time: recording.length, place: null }
  const sameNumber = { time: Math.max(0, Math.min(time, recording.length)), place: null }
  if (!keepPlace || engine.mapMoment === undefined) return sameNumber
  if (previous.program.source === recording.program.source) return sameNumber
  if (previous.length > KEEP_PLACE_MAX_STEPS || recording.length > KEEP_PLACE_MAX_STEPS) {
    return sameNumber
  }
  const moment = engine.mapMoment(previous, recording, time)
  return {
    time: Math.max(0, Math.min(moment.time, recording.length)),
    place: { call: moment.call, precision: moment.precision },
  }
}

/** The edit behind `recording`, when it re-records an edited version of `previous`. */
export function editRunOf(
  previous: Recording | null,
  recording: Recording,
  place: KeptPlace['place'],
): EditRun | null {
  if (previous === null || previous.program.source === recording.program.source) return null
  return { previous, recording, place }
}
