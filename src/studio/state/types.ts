/**
 * Studio state contract. Components read state through `useStudio(selector)` and change it only
 * through the actions; every update produces new objects (no in-place mutation).
 */
import type {
  AsyncRecordOptions,
  CompileResult,
  Direction,
  Recording,
  StepKind,
  WriteTarget,
} from '../../core/api-types'
import type { Program } from '../../core/bytecode'
import type { Diagnostic } from '../../core/diagnostics'

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
}

export interface StudioActions {
  /** Replaces the editor text; recompiles now and schedules an auto-run. */
  setSource(source: string): void
  loadExample(id: string): void
  /** Compiles and records the current source now (aborting any recording in progress). */
  run(): Promise<void>
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
}

export type StudioStore = StudioState & StudioActions

/** The engine the store drives; the real one wraps src/core, tests pass fakes. */
export interface Engine {
  compile(source: string): CompileResult
  recordAsync(program: Program, options: AsyncRecordOptions): Promise<Recording>
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
}

/** Timers, injectable so tests can drive debounce and playback deterministically. */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): number
  clearTimeout(handle: number): void
  setInterval(callback: () => void, ms: number): number
  clearInterval(handle: number): void
}
