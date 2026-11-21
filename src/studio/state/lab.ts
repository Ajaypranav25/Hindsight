/**
 * The studio side of temporal queries and parameter sweeps (ARCHITECTURE §7.9, §7.13, §11.3):
 * what the strip chart marks besides the run itself. Like the bug finder's interview, each belongs
 * to one recording: once another recording is shown it is no longer live (`liveQuery`,
 * `liveSweep`), so runs, edits and examples need no reset. A sweep comes back when its recording
 * does (after "Back to the real run" from one of its runs).
 */
import type { StoreApi } from 'zustand/vanilla'
import {
  type EditValue,
  type ForkError,
  type QueryResult,
  type Recording,
  type WhyNot,
  whyNot,
  type WriteTarget,
} from '../../core/index'
import type { CausalLink, SliceSummary, SweepRunSummary, SweepSummary } from '../analysis/protocol'
import { analyze } from '../analysis/service'
import type { StudioActions, StudioState, StudioStore } from './types'
import { PEN_AT_END_NOTICE } from './what-if'

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
  /** The runs without their recordings (a row is forked again when it is opened). */
  readonly runs: readonly SweepRunSummary[]
  readonly failed: readonly { readonly value: EditValue; readonly error: ForkError }[]
}

/** The explanation of why a line did not run, shown in the editor. */
export interface WhyNotMark {
  readonly recording: Recording
  readonly line: number
  readonly why: WhyNot
}

/**
 * The backward slice of step `at` (ARCHITECTURE §7.8) as the editor and the strip chart show it.
 * `lines` is null when the run is too long to analyze; the other parts are then empty.
 */
export interface SliceMark {
  readonly recording: Recording
  readonly at: number
  /** The lines with a causal path to step `at`. */
  readonly lines: ReadonlySet<number> | null
  /** Per step `0..N`: 1 when the step is in the slice (null without a slice). */
  readonly marks: Uint8Array | null
  /** The named writes the step was computed from, newest first. */
  readonly chain: readonly CausalLink[]
  readonly chainTotal: number
  /** The line the sliced step ran on (the effect), when it is user code. */
  readonly effectLine: number | null
  /** Why there is no slice, when there is none. */
  readonly problem: string | null
}

export const SLICE_TOO_LONG = 'This run is too long to trace'
export const SLICE_FAILED = 'The causes could not be traced'

/** The mark for a slice summary from the analysis service (null: no slice, for `problem`). */
export function sliceMark(
  recording: Recording,
  at: number,
  summary: SliceSummary | null,
  problem = SLICE_TOO_LONG,
): SliceMark {
  if (summary === null) {
    return {
      recording,
      at,
      lines: null,
      marks: null,
      chain: [],
      chainTotal: 0,
      effectLine: null,
      problem,
    }
  }
  return {
    recording,
    at,
    problem: null,
    lines: new Set(summary.lines),
    marks: summary.marks,
    chain: summary.chain,
    chainTotal: summary.chainTotal,
    effectLine: summary.effectLine,
  }
}

export interface LabState {
  readonly query: QueryMarks | null
  readonly sweep: SweepState | null
  readonly whyNot: WhyNotMark | null
  /** The slice last computed for the editor. */
  readonly slice: SliceMark | null
  /**
   * "What led here?" / "What led to this?": the step the user asked to trace, and what to call it
   * ("output line 3"); it lasts until it is dismissed.
   */
  readonly sliceAt: {
    readonly recording: Recording
    readonly time: number
    readonly label: string | null
  } | null
  /** Dim the lines that did not lead to a runtime error. */
  readonly dimming: boolean
}

export const INITIAL_LAB: LabState = {
  query: null,
  sweep: null,
  whyNot: null,
  slice: null,
  sliceAt: null,
  dimming: true,
}

/** Runs longer than this are traced only when the user asks ("What led here?"). */
export const MAX_AUTO_SLICE_STEPS = 1_000_000

/** The explanation for `recording`, or null. */
export function liveWhyNot(lab: LabState, recording: Recording | null): WhyNotMark | null {
  return lab.whyNot !== null && lab.whyNot.recording === recording ? lab.whyNot : null
}

/**
 * The step the editor wants traced: the one the user asked about ("What led here?", "What led to
 * this?"), which stays traced while the pen explores its causes, else the failure of a run that
 * ended in an error (while dimming is on and the run is short enough); null for none.
 */
export function wantedSliceStep(state: StudioState): number | null {
  const { recording, lab } = state
  if (recording === null || state.recordedSource !== state.source) return null
  const asked = lab.sliceAt
  if (asked !== null && asked.recording === recording) return asked.time
  const failed = recording.outcome.kind === 'error'
  return failed && lab.dimming && recording.length <= MAX_AUTO_SLICE_STEPS ? recording.length : null
}

/** The computed slice the editor shows now, or null (none wanted, or not computed yet). */
export function activeSlice(state: StudioState): SliceMark | null {
  const wanted = wantedSliceStep(state)
  const { slice } = state.lab
  return wanted !== null &&
    slice !== null &&
    slice.recording === state.recording &&
    slice.at === wanted
    ? slice
    : null
}

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
  | 'setQueryMarks'
  | 'sweepWhatIf'
  | 'openSweepRun'
  | 'closeSweep'
  | 'askWhyNot'
  | 'closeWhyNot'
  | 'setSlice'
  | 'sliceFrom'
  | 'setDimming'
>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function labActions(
  get: StoreApi<StudioStore>['getState'],
  set: StoreApi<StudioStore>['setState'],
): LabActions {
  /** The sweep in flight; aborting it stops its remaining forks. */
  let pending: AbortController | null = null
  const stop = (): void => {
    pending?.abort()
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
      const controller = new AbortController()
      pending = controller
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
      // The sweep is about the run on screen: it ends when another run is shown.
      const progress = (done: number): void => {
        if (get().recording !== recording) return controller.abort()
        if (get().lab.sweep?.recording === recording) {
          set({ lab: { ...get().lab, sweep: { ...started, done } } })
        }
      }
      let result: SweepSummary | null = null
      let problem: string | null = null
      try {
        const request = { kind: 'sweep', time, target, values } as const
        result = (await analyze(recording, request, controller.signal, progress)).sweep
      } catch (error) {
        if (!controller.signal.aborted) problem = errorText(error)
      }
      // Closed, or replaced by a newer sweep: that already settled the state.
      if (pending !== controller) return
      pending = null
      if (get().lab.sweep?.recording !== recording) return
      if (result === null || get().recording !== recording) {
        // Another run was shown before every value was tried: half a sweep is not kept.
        set({ lab: { ...get().lab, sweep: null } })
        if (problem !== null) set({ notice: { text: `No sweep: ${problem}`, tone: 'error' } })
        return
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

    async openSweepRun(index) {
      const { lab, recording } = get()
      const sweep = liveSweep(lab, recording)
      const run = sweep?.runs[index]
      if (sweep === null || run === undefined) return
      // The run is forked again on this thread (the sweep kept only its summary), leaving the
      // same state a manual what-if at that step with that value leaves behind.
      get().seek(sweep.time)
      await get().forkWhatIf(sweep.target, run.value, sweep.name)
    },

    closeSweep() {
      stop()
      if (get().lab.sweep !== null) set({ lab: { ...get().lab, sweep: null } })
    },

    askWhyNot(line) {
      const { recording, source, recordedSource, lab } = get()
      // Lines of an edited program no longer match the recording.
      if (recording === null || recordedSource !== source) return
      set({ lab: { ...lab, whyNot: { recording, line, why: whyNot(recording, line) } } })
    },

    closeWhyNot() {
      if (get().lab.whyNot !== null) set({ lab: { ...get().lab, whyNot: null } })
    },

    setSlice(slice) {
      set({ lab: { ...get().lab, slice } })
    },

    sliceFrom(time, label = null) {
      const { recording, lab } = get()
      const sliceAt = time === null || recording === null ? null : { recording, time, label }
      set({ lab: { ...lab, sliceAt } })
    },

    setDimming(dimming) {
      set({ lab: { ...get().lab, dimming } })
    },
  }
}
