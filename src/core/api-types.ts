/**
 * Public types for tools built on the core (the studio, the CLI, tests).
 * See docs/ARCHITECTURE.md §7–8 for semantics.
 */
import type { LocalKind, Program } from './bytecode'
import type { Diagnostic, RuntimeErrorCode } from './diagnostics'
import type { Span } from './span'

export const DEFAULT_MAX_STEPS = 2_000_000
export const DEFAULT_SEED = 42

export type TypeName =
  'nil' | 'bool' | 'number' | 'string' | 'list' | 'record' | 'function' | 'range'

// ---------------------------------------------------------------------------------------------
// Compiling and running

export type CompileResult =
  | { readonly ok: true; readonly program: Program; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

export interface RunOptions {
  /** Default DEFAULT_MAX_STEPS. */
  readonly maxSteps?: number
  /** Default DEFAULT_SEED. */
  readonly seed?: number
  /** Called synchronously for every `print`. */
  readonly onOutput?: (text: string) => void
}

export interface RunResult {
  readonly outputs: readonly OutputEvent[]
  readonly outcome: Outcome
  /** Number of steps executed (N). */
  readonly steps: number
}

export interface StackEntry {
  /** Display name: a function name, `lambda`, or `<top level>`. */
  readonly name: string
  /** Span of the frame's current instruction (for callers: the call being waited on). */
  readonly span: Span
  readonly library: boolean
}

export interface RuntimeErrorInfo {
  readonly code: RuntimeErrorCode
  readonly message: string
  readonly hint?: string
  /** Location in the main source (SPEC §10.4); failures in library code map to the user call. */
  readonly span: Span
  /** Innermost first. */
  readonly stack: readonly StackEntry[]
  /** The step at which the error happened (= N). */
  readonly time: number
}

export type Outcome =
  | { readonly kind: 'finished' }
  | { readonly kind: 'error'; readonly error: RuntimeErrorInfo }
  | { readonly kind: 'step-limit'; readonly maxSteps: number }
  | { readonly kind: 'aborted' }

/** One `print`. The text is visible in every state after `time` (SPEC §10.2). */
export interface OutputEvent {
  readonly time: number
  readonly text: string
}

// ---------------------------------------------------------------------------------------------
// Locations and state views

export interface Location {
  readonly protoId: number
  readonly ip: number
  /** Number of frames minus one: 0 is top-level code. */
  readonly depth: number
  /** Display name of the executing function. */
  readonly functionName: string
  readonly source: 'main' | 'prelude'
  readonly library: boolean
  /** Span of the instruction, in its source (`main` or the prelude). */
  readonly span: Span
  /** Span of the innermost enclosing statement (or match arm, or lambda expression body). */
  readonly stmtSpan: Span
  /** 1-based line of `span.start` in its source. */
  readonly line: number
  /** 1-based line of `stmtSpan.start`: the line breakpoints and execution heat use. */
  readonly stmtLine: number
  readonly stmtStart: boolean
  /** Instruction mnemonic, e.g. `Add`. */
  readonly opName: string
}

export type RefType = 'list' | 'record' | 'function' | 'builtin' | 'range' | 'iterator'

export type ValueView =
  | { readonly kind: 'nil' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | {
      readonly kind: 'ref'
      readonly id: number
      readonly type: RefType
      /** A bounded `repr`, about 48 characters at most. */
      readonly preview: string
    }

/** Where a value lives, for provenance queries (ARCHITECTURE §6.7, §7.3). */
export type WriteTarget =
  | { readonly kind: 'local'; readonly frameUid: number; readonly slot: number }
  | { readonly kind: 'global'; readonly name: string }
  | { readonly kind: 'field'; readonly objectId: number; readonly key: string }
  /** `index` is always the normalized, non-negative index. */
  | { readonly kind: 'element'; readonly objectId: number; readonly index: number }
  | { readonly kind: 'object'; readonly objectId: number }
  | { readonly kind: 'cell'; readonly cellId: number }

export interface CaptureView {
  readonly name: string
  readonly value: ValueView
  readonly target: WriteTarget
}

/** Lists and records include at most `limit` (default 100) items/entries; `length` is the total. */
export type ObjectView =
  | {
      readonly type: 'list'
      readonly id: number
      /** Index of `items[0]` within the list. */
      readonly offset: number
      readonly items: readonly ValueView[]
      readonly length: number
    }
  | {
      readonly type: 'record'
      readonly id: number
      readonly offset: number
      readonly entries: readonly { readonly key: string; readonly value: ValueView }[]
      readonly length: number
    }
  | {
      readonly type: 'function'
      readonly id: number
      readonly name: string | null
      readonly protoId: number
      readonly library: boolean
      readonly captures: readonly CaptureView[]
    }
  | { readonly type: 'builtin'; readonly id: number; readonly name: string }
  | {
      readonly type: 'range'
      readonly id: number
      readonly start: number
      readonly end: number
      readonly step: number
      readonly inclusive: boolean
    }
  | {
      readonly type: 'iterator'
      readonly id: number
      readonly source: ValueView
      readonly position: number
    }

export interface LocalView {
  readonly name: string
  readonly slot: number
  readonly kind: LocalKind
  readonly mutable: boolean
  readonly value: ValueView
  readonly declSpan: Span
  readonly target: WriteTarget
}

export interface FrameView {
  readonly uid: number
  readonly name: string
  readonly protoId: number
  readonly ip: number
  readonly library: boolean
  readonly source: 'main' | 'prelude'
  /** Current instruction (for callers: the call they are waiting on). */
  readonly span: Span
  readonly stmtSpan: Span
  readonly line: number
  /** Live, non-hidden locals in slot order. */
  readonly locals: readonly LocalView[]
  /** The closure's captured variables. */
  readonly captures: readonly CaptureView[]
  /** Operand-stack values above the highest live local. */
  readonly temps: readonly ValueView[]
}

export interface GlobalView {
  readonly name: string
  readonly kind: 'let' | 'var' | 'fn'
  readonly mutable: boolean
  readonly value: ValueView
  readonly declSpan: Span
  readonly target: WriteTarget
}

export interface StateView {
  readonly time: number
  /** The instruction about to execute; at N, the failing or paused instruction (null if finished). */
  readonly location: Location | null
  /** Outermost first; the last frame is executing. Empty at N when the program finished. */
  readonly frames: readonly FrameView[]
  /** Defined user globals in definition order. */
  readonly globals: readonly GlobalView[]
  /** Objects reachable from the roots, breadth first, bounded by `heapLimit` (ARCHITECTURE §7.4). */
  readonly heap: ReadonlyMap<number, ObjectView>
  readonly heapTruncated: boolean
  /** Number of output events with `time < this.time`. */
  readonly outputCount: number
  /** Set only at time N when the run ended with an error. */
  readonly error: RuntimeErrorInfo | null
}

// ---------------------------------------------------------------------------------------------
// Provenance

/** A value stored with an event: primitives as-is, objects by id. */
export type TracedValue = null | boolean | number | string | { readonly ref: number }

/**
 * `declare`/`write`: a variable, field or element got a value. `alloc`: an object was created
 * (target `{kind: 'object'}`). `list`: a list changed shape (target `{kind: 'object'}`, see `op`).
 * `delete`: `delete(record, key)` removed a key (target `{kind: 'field'}`, value nil).
 */
export type EventKind = 'declare' | 'write' | 'alloc' | 'list' | 'delete'

export type ListOp = 'append' | 'extend' | 'insert' | 'remove' | 'pop'

export interface ProvenanceEvent {
  /** The step that performed it; the effect is visible from `time + 1`. */
  readonly time: number
  readonly kind: EventKind
  readonly target: WriteTarget
  /** The value written; for `alloc` `{ref: id}`; for `list` the item (or the extended iterable). */
  readonly value: TracedValue
  /** For `list` events. */
  readonly op?: ListOp
  /** For `list` events: the normalized index the change happened at. */
  readonly index?: number
  /** For `list` events: number of items appended by `extend` (1 otherwise). */
  readonly count?: number
}

export interface HistoryWindow {
  readonly from?: number
  readonly to?: number
  /** Default 1000. */
  readonly limit?: number
}

export interface HistoryResult {
  /** Ascending by time; evenly sampled (first and last kept) when `truncated`. */
  readonly events: readonly ProvenanceEvent[]
  /** Number of events in the window before sampling. */
  readonly total: number
  readonly truncated: boolean
}

// ---------------------------------------------------------------------------------------------
// Recording

export type StepKind = 'into' | 'over' | 'out'
export type Direction = 'forward' | 'backward'

export interface NavOptions {
  /** Skip library (prelude) code. Default false. */
  readonly justMyCode?: boolean
}

export interface RecordOptions {
  /** Default DEFAULT_MAX_STEPS. */
  readonly maxSteps?: number
  /** Default DEFAULT_SEED. */
  readonly seed?: number
  /** Maximum retained snapshots. Default 512. */
  readonly snapshotBudget?: number
  /** Maximum objects in `StateView.heap`. Default 250. */
  readonly heapLimit?: number
}

export interface AsyncRecordOptions extends RecordOptions {
  /** Polled between slices; when `aborted` becomes true the recording ends with outcome `aborted`. */
  readonly signal?: { readonly aborted: boolean }
  readonly onProgress?: (time: number) => void
  /** Work per slice before yielding to the event loop. Default 8 ms. */
  readonly sliceMs?: number
}

/**
 * A recorded run. Times are integers in `0..=length`; any other time throws `InternalError`.
 * Treat it as immutable: every method is a query (internal caches aside); `extend` and
 * `extendAsync` return a new Recording and leave this one unchanged.
 */
export interface Recording {
  readonly program: Program
  /** N: the number of steps executed. */
  readonly length: number
  readonly outcome: Outcome
  readonly outputs: readonly OutputEvent[]

  /** The instruction about to execute at `t`; at N, the failing or paused instruction (or null). */
  locationAt(t: number): Location | null
  depthAt(t: number): number
  /** Depth per step, length N (do not mutate). */
  depthSeries(): Int32Array
  stateAt(t: number): StateView
  /** A reachable object at `t`, paging long lists and records; null when not reachable at `t`. */
  objectAt(
    t: number,
    id: number,
    range?: { readonly offset: number; readonly limit: number },
  ): ObjectView | null
  /** Number of output events with `time < t`. */
  outputCountAt(t: number): number

  step(t: number, kind: StepKind, direction: Direction, options?: NavOptions): number
  continue(
    t: number,
    direction: Direction,
    breakpoints: ReadonlySet<number>,
    options?: NavOptions,
  ): number
  /** Times `t < N` at which a user-code statement on `line` (its statement line) starts. */
  lineHits(line: number): readonly number[]
  /** line → number of hits. */
  lineHitCounts(): ReadonlyMap<number, number>

  /** The latest event that produced the target's value before `before` (ARCHITECTURE §7.3). */
  origin(target: WriteTarget, before: number): ProvenanceEvent | null
  /** The events of the binding live at `at` (ARCHITECTURE §7.3). */
  history(target: WriteTarget, at: number, window?: HistoryWindow): HistoryResult
  allocationTime(objectId: number): number | null

  /** Continues a `step-limit` or `aborted` recording for up to `extraSteps` more steps. */
  extend(extraSteps: number): Recording
  extendAsync(extraSteps: number, options?: AsyncRecordOptions): Promise<Recording>
}
