/**
 * The studio side of temporal queries and parameter sweeps (ARCHITECTURE §7.9, §7.13, §11.3):
 * what the strip chart marks besides the run itself. Like the bug finder's interview, each belongs
 * to one recording: once another recording is shown it is no longer live (`liveQuery`,
 * `liveSweep`), so runs, edits and examples need no reset. A sweep comes back when its recording
 * does (after "Back to the real run" from one of its runs).
 */
import type { StoreApi } from 'zustand/vanilla'
import {
  compareRecordings,
  type EditValue,
  type ForkError,
  formatLiteral,
  type QueryResult,
  type Recording,
  sweepAsync,
  type SweepRun,
  type WriteTarget,
} from '../../core/index'
import type { StudioActions, StudioStore } from './types'
import { PEN_AT_END_NOTICE, whatIfLabel } from './what-if'

/** A query's answer, marked on the strip chart of the recording it was asked about. */
export interface QueryMarks {
  readonly recording: Recording
  readonly text: string
  readonly result: QueryResult
}

/** One what-if per value of a variable at one step, shown together. */
export interface SweepState {
  /** The run that was swept. */
  readonly recording: Recording
  /** The fork step. */
  readonly time: number
  readonly target: WriteTarget
  readonly name: string
  /** `start = 1..20`. */
  readonly label: string
  readonly total: number
  /** Values forked so far (runs and failures). */
  readonly done: number
  readonly running: boolean
  readonly runs: readonly SweepRun[]
  readonly failed: readonly { readonly value: EditValue; readonly error: ForkError }[]
}

export interface LabState {
  readonly query: QueryMarks | null
  readonly sweep: SweepState | null
}

export const INITIAL_LAB: LabState = { query: null, sweep: null }

/** The query marks for `recording`, or null. */
export function liveQuery(lab: LabState, recording: Recording | null): QueryMarks | null {
  return lab.query !== null && lab.query.recording === recording ? lab.query : null
}

/** The sweep of `recording`, or null. */
export function liveSweep(lab: LabState, recording: Recording | null): SweepState | null {
  return lab.sweep !== null && lab.sweep.recording === recording ? lab.sweep : null
}

type LabActions = Pick<
  StudioActions,
  'setQueryMarks' | 'sweepWhatIf' | 'openSweepRun' | 'closeSweep'
>

export function labActions(
  get: StoreApi<StudioStore>['getState'],
  set: StoreApi<StudioStore>['setState'],
): LabActions {
  /** The sweep in flight; aborting it stops its remaining forks. */
  let pending: { aborted: boolean } | null = null
  const stop = (): void => {
    if (pending !== null) pending.aborted = true
    pending = null
  }
  return {
    setQueryMarks(query) {
      set({ lab: { ...get().lab, query } })
    },

    async sweepWhatIf(target, values, name, text) {
      const { recording, time, status } = get()
      if (recording === null || status.kind === 'recording') return
      if (time >= recording.length) return set({ notice: PEN_AT_END_NOTICE })
      stop()
      const token = { aborted: false }
      pending = token
      // The sweep is about the run on screen: it ends when another run is shown.
      const signal = {
        get aborted() {
          return token.aborted || get().recording !== recording
        },
      }
      const started: SweepState = {
        recording,
        time,
        target,
        name,
        label: `${name} = ${text.trim()}`,
        total: values.length,
        done: 0,
        running: true,
        runs: [],
        failed: [],
      }
      set({ lab: { ...get().lab, sweep: started } })
      const result = await sweepAsync(recording, time, target, values, {
        signal,
        onRun: (done) => {
          const sweep = get().lab.sweep
          if (sweep === started || sweep?.recording === recording) {
            set({ lab: { ...get().lab, sweep: { ...started, done } } })
          }
        },
      })
      if (pending === token) pending = null
      // Closed, or replaced by a newer sweep: that already settled the state.
      if (token.aborted) return
      const current = get().lab.sweep
      if (current?.recording !== recording) return
      if (get().recording !== recording) {
        // Another run was shown before every value was tried: half a sweep is not kept.
        return set({ lab: { ...get().lab, sweep: null } })
      }
      set({
        lab: {
          ...get().lab,
          sweep: {
            ...started,
            done: result.runs.length + result.failed.length,
            running: false,
            runs: result.runs,
            failed: result.failed,
          },
        },
      })
    },

    openSweepRun(index) {
      const { lab, recording, whatIf } = get()
      const sweep = liveSweep(lab, recording)
      const run = sweep?.runs[index]
      if (sweep === null || run === undefined || recording === null) return
      // The same state a manual what-if at that step with that value leaves behind.
      const parent = whatIf?.parent ?? recording
      const earlier = whatIf?.edits.filter((edit) => edit.time <= sweep.time) ?? []
      const edits = [
        ...earlier,
        { time: sweep.time, text: `${sweep.name} = ${formatLiteral(run.value)}` },
      ]
      get().stopPlay()
      set({
        recording: run.recording,
        time: sweep.time,
        selectedFrameUid: null,
        originMark: null,
        whatIf: {
          parent,
          parentTime: whatIf?.parentTime ?? sweep.time,
          edits,
          label: whatIfLabel(edits),
          comparison:
            parent === recording ? run.comparison : compareRecordings(parent, run.recording),
        },
      })
    },

    closeSweep() {
      stop()
      if (get().lab.sweep !== null) set({ lab: { ...get().lab, sweep: null } })
    },
  }
}
