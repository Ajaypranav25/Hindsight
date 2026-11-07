/**
 * Studio state contract. Components read state through `useStudio(selector)` and change it only
 * through the actions; every update produces new objects (no in-place mutation).
 */
import type {
  AsyncRecordOptions,
  CompileResult,
  Direction,
  EditValue,
  Recording,
  RecordingComparison,
  StepKind,
  WriteTarget,
} from '../../core/api-types'
import type { Program } from '../../core/bytecode'
import type { Diagnostic } from '../../core/diagnostics'
import type { Answer } from '../../core/index'
import type { BugFinderState } from './bug-finder'

export type ThemeSetting = 'system' | 'light' | 'dark'

export interface Settings {
  /** Step budget for a recording: 500,000, 2,000,000 or 10,000,000. */
  readonly maxSteps: number
  /** Skip library frames when stepping and in the call stack. */
  readonly justMyCode: boolean
  /** Re-record shortly after edits when the program compiles. */
  readonly autoRun: boolean
  /** Show instruction-level detail (opName, operand temps, single-instruction steps). */
  readonly instructionLevel: boolean
  readonly theme: ThemeSetting
  /** Statements per second during playback. */
  readonly playbackSpeed: number
}

export type RunStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'compile-error'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: 'recording'; readonly progress: number }
  | { readonly kind: 'ready' }

export interface Notice {
  readonly text: string
  readonly tone: 'info' | 'error'
  /** A button the notice offers: bring back the program a link or an example replaced. */
  readonly action?: 'restore-previous'
}

/** The write being explained after an origin jump: the pen sits one step after `time`. */
export interface OriginMark {
  /** The step that performed the write (the pen is at `time + 1`, clamped). */
  readonly time: number
  readonly label: string
}

export interface StudioState {
  readonly source: string
  /** The gallery example the source came from, if unchanged since loading. */
  readonly exampleId: string | null
  /** Latest compile of `source`. */
  readonly compile: CompileResult | null
  /** Latest completed recording; may be stale (made from different source). */
  readonly recording: Recording | null
  /** The source `recording` was made from. */
  readonly recordedSource: string | null
  readonly status: RunStatus
  /** The pen: an integer in [0, recording.length]. 0 when there is no recording. */
  readonly time: number
  /** Selected frame; null means the innermost (executing) frame. */
  readonly selectedFrameUid: number | null
  /** Breakpoint lines (1-based). */
  readonly breakpoints: ReadonlySet<number>
  /** The binding whose history is marked on the strip chart. */
  readonly watch: {
    readonly target: WriteTarget
    readonly label: string
    readonly at: number
  } | null
  readonly playing: boolean
  readonly settings: Settings
  readonly hintDismissed: boolean
  readonly notice: Notice | null
  /** Set by `jumpToOrigin`; any later seek, run or example load clears it. */
  readonly originMark: OriginMark | null
  /** The user's own program, kept when a share link or an example replaced it (else null). */
  readonly previousSource: string | null
  /** Set while `recording` is a what-if fork of the real run (ARCHITECTURE §7.5). */
  readonly whatIf: WhatIfState | null
  /** The bug finder's interview (ARCHITECTURE §7.6) and requests to reveal its panel. */
  readonly bugFinder: BugFinderState
}

/** One edit of a what-if, as the studio names it. */
export interface WhatIfEditLabel {
  /** The fork step. */
  readonly time: number
  /** e.g. `total = 0`. */
  readonly text: string
}

export interface WhatIfState {
  /** The real run, restored by `leaveWhatIf`. */
  readonly parent: Recording
  /** The pen in the real run when the first edit was made. */
  readonly parentTime: number
  /** The edits in this timeline, oldest first. */
  readonly edits: readonly WhatIfEditLabel[]
  /** "total = 0 at step 3,500", or "2 edits". */
  readonly label: string
  /** The real run (a) against the what-if (b). */
  readonly comparison: RecordingComparison
}

export interface StudioActions {
  /** Replaces the editor text; recompiles now and schedules an auto-run. */
  setSource(source: string): void
  loadExample(id: string): void
  /** Compiles and records the current source now (aborting any recording in progress). */
  run(): Promise<void>
  /**
   * The page-load run: records the opening program unless the previous page's run never finished
   * (it froze or crashed the tab), in which case it only explains why nothing ran.
   */
  startup(): Promise<void>
  /** Continues a step-limited recording by another `settings.maxSteps` steps. */
  extend(): Promise<void>
  /** Moves the pen (clamped to the recording). */
  seek(time: number): void
  stepNav(kind: StepKind, direction: Direction): void
  continueNav(direction: Direction): void
  /** Moves exactly one instruction (instruction-level stepping). */
  stepInstruction(direction: Direction): void
  jumpToStart(): void
  jumpToEnd(): void
  togglePlay(): void
  stopPlay(): void
  toggleBreakpoint(line: number): void
  /** Replaces every breakpoint (the editor moves them as lines are inserted and deleted). */
  setBreakpoints(lines: Iterable<number>): void
  selectFrame(uid: number | null): void
  /**
   * Moves the pen just after the step that produced the target's current value and marks that
   * step (`originMark`).
   */
  jumpToOrigin(target: WriteTarget, label: string): void
  /** Marks a binding's history on the strip chart (null clears). */
  setWatch(target: WriteTarget | null, label?: string): void
  updateSettings(patch: Partial<Settings>): void
  dismissHint(): void
  clearNotice(): void
  /**
   * Swaps `previousSource` back into the editor and records it; the program it replaces is kept
   * in turn when it is the user's own. Does nothing when no program was kept.
   */
  restorePreviousSource(): void
  /**
   * Opens a share link's program in a running studio, keeping the program it replaces; a moment
   * link's `time` places the pen once it has been recorded.
   */
  openSharedSource(source: string, time?: number | null): void
  /** Forks the shown run at the pen with `target` set to `value` (`name` labels the edit). */
  forkWhatIf(target: WriteTarget, value: EditValue, name: string): Promise<void>
  /** Leaves what-if mode: the real run comes back with its pen. */
  leaveWhatIf(): void
  /**
   * Reveals the bug finder and, unless an interview is open or the run ended with an error,
   * starts one about the whole program.
   */
  openBugFinder(): void
  /** Starts an interview below the call that begins at step `entry` (the whole program by default). */
  startBugFinder(entry?: number): void
  /** Judges the open question about a call. */
  answerBugFinder(answer: Answer): void
  /** Takes back the last answer. */
  undoBugFinder(): void
  closeBugFinder(): void
}

export type StudioStore = StudioState & StudioActions

/** The engine the store drives; the real one wraps src/core, tests pass fakes. */
export interface Engine {
  compile(source: string): CompileResult
  recordAsync(program: Program, options: AsyncRecordOptions): Promise<Recording>
  /** Compares the real run `a` with a what-if `b`. */
  compare(a: Recording, b: Recording): RecordingComparison
}

/**
 * Where the pen starts on a freshly recorded example: the top of the tallest call peak, the start,
 * the end, or a fraction (0 to 1) of the run. Runs that end in an error always open at the failure.
 */
export type PenPosition = 'peak' | 'start' | 'end' | number

/** A gallery program. */
export interface Example {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly source: string
  /** The outcome the example is written to have. */
  readonly outcome: 'finished' | 'error'
  readonly pen: PenPosition
}

/** Key-value persistence that may be unavailable (private windows, sandboxed previews). */
export interface KeyValueStorage {
  read(key: string): string | null
  write(key: string, value: string): void
  remove(key: string): void
}

/** Timers, injectable so tests can drive debounce and playback deterministically. */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): number
  clearTimeout(handle: number): void
  setInterval(callback: () => void, ms: number): number
  clearInterval(handle: number): void
}
