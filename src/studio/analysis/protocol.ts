/**
 * The analysis worker's protocol (ARCHITECTURE §11.7). A recording cannot cross a thread boundary,
 * so a request carries a plain description of the run instead: the program, the seed, the step
 * limit and the chain of what-if edits that made it. Recording is deterministic, so the worker
 * records the same run again (forks are reproduced by replaying the same fork requests) and
 * answers with plain data; typed arrays travel as transferables.
 */
import type {
  EditValue,
  ForkError,
  InverseGoal,
  InverseResult,
  Outcome,
  QueryOutcome,
  RecordingComparison,
  RepairRequest,
  RepairResult,
  TimedEdit,
  WriteTarget,
} from '../../core/index'

/** Everything needed to record a run again, step for step. */
export interface RunDescription {
  readonly source: string
  readonly seed: number
  /** The step limit of the run and of every fork in its chain. */
  readonly maxSteps: number
  /** The what-if edits that made it, oldest first (empty for a real run). */
  readonly edits: readonly TimedEdit[]
  /** The run's length and outcome, checked after recording it again. */
  readonly length: number
  readonly outcome: Outcome['kind']
}

/** One write in a slice, as the slice chip lists it: `total = 72 · step 410 · line 8`. */
export interface CausalLink {
  /** The step that performed the write. */
  readonly time: number
  readonly name: string
  /** The value written, as a short text. */
  readonly value: string
  /** The line of the main source that performed it, or null (library code). */
  readonly line: number | null
}

/** A backward slice reduced to what the studio shows. */
export interface SliceSummary {
  /** The step the slice was taken from. */
  readonly at: number
  /** 1-based lines with a step in the slice, ascending. */
  readonly lines: readonly number[]
  /** Per step `0..N`: 1 when the step is in the slice. */
  readonly marks: Uint8Array
  /** Number of steps in the slice. */
  readonly steps: number
  /** The named writes the step was computed from, newest first (at most `MAX_CHAIN`). */
  readonly chain: readonly CausalLink[]
  /** How many named writes the slice holds in all. */
  readonly chainTotal: number
  /** The line the sliced step ran on, when it is user code. */
  readonly effectLine: number | null
}

/** One run of a sweep, without its recording: what the banner and the ghost trace need. */
export interface SweepRunSummary {
  readonly value: EditValue
  readonly length: number
  readonly outcome: Outcome
  readonly comparison: RecordingComparison
  readonly maxDepth: number
  /** The run's depth per step (its ghost trace). */
  readonly depths: Int32Array
}

export interface SweepSummary {
  readonly runs: readonly SweepRunSummary[]
  readonly failed: readonly { readonly value: EditValue; readonly error: ForkError }[]
}

export type AnalysisRequest =
  | { readonly kind: 'slice'; readonly at: number }
  | { readonly kind: 'query'; readonly text: string; readonly limit: number }
  | { readonly kind: 'solve'; readonly goal: InverseGoal }
  | { readonly kind: 'repair'; readonly request: RepairRequest }
  | {
      readonly kind: 'sweep'
      readonly time: number
      readonly target: WriteTarget
      readonly values: readonly EditValue[]
    }

export type AnalysisResult =
  | { readonly kind: 'slice'; readonly slice: SliceSummary | null }
  | { readonly kind: 'query'; readonly outcome: QueryOutcome }
  | { readonly kind: 'solve'; readonly result: InverseResult }
  | { readonly kind: 'repair'; readonly result: RepairResult }
  | { readonly kind: 'sweep'; readonly sweep: SweepSummary }

/** The result type that answers request kind `K`. */
export type ResultOf<K extends AnalysisRequest['kind']> = Extract<AnalysisResult, { kind: K }>

/** Main thread to worker. */
export type ToWorker =
  | {
      readonly type: 'analyze'
      readonly id: number
      readonly run: RunDescription
      readonly request: AnalysisRequest
    }
  /** Stop job `id` at its next pause (searches pause between forks and mutants). */
  | { readonly type: 'cancel'; readonly id: number }

/** Worker to main thread. */
export type FromWorker =
  | { readonly type: 'ready' }
  | { readonly type: 'done'; readonly id: number; readonly result: AnalysisResult }
  /** The job stopped because it was cancelled. */
  | { readonly type: 'cancelled'; readonly id: number }
  /** A sweep's progress: how many of its values have been forked so far. */
  | { readonly type: 'progress'; readonly id: number; readonly done: number }
  /** The worker could not do the job (the main thread then does it itself). */
  | { readonly type: 'failed'; readonly id: number; readonly error: string }

/** The most links a slice summary lists. */
export const MAX_CHAIN = 40

/** Requests that run many forks or mutants; the others are single passes over the run. */
export function isSearch(request: AnalysisRequest): boolean {
  return request.kind === 'solve' || request.kind === 'repair' || request.kind === 'sweep'
}

/** Requests whose job reports progress as it goes (a sweep, one fork per value). */
export function reportsProgress(request: AnalysisRequest): boolean {
  return request.kind === 'sweep'
}

/** The typed arrays in a result, which travel as transferables instead of being copied. */
export function transferablesOf(result: AnalysisResult): ArrayBuffer[] {
  if (result.kind === 'slice' && result.slice !== null) {
    return [result.slice.marks.buffer as ArrayBuffer]
  }
  if (result.kind === 'sweep')
    return result.sweep.runs.map((run) => run.depths.buffer as ArrayBuffer)
  return []
}
