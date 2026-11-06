import { createStore, type StoreApi } from 'zustand/vanilla'
import type {
  Direction,
  ProvenanceEvent,
  Recording,
  StepKind,
  WriteTarget,
} from '../../core/api-types'
import { writeJson } from '../lib/storage'
import {
  ACTION_NOTICE_DURATION_MS,
  AUTO_RUN_DELAY_MS,
  NOTICE_DURATION_MS,
  penTime,
  PERSIST_DELAY_MS,
  STORAGE_KEYS,
} from './defaults'
import {
  initialState,
  lastRunUnfinished,
  UNFINISHED_RUN_NOTICE,
  type Startup,
} from './initial-state'
import {
  KEPT_AFTER_EXAMPLE_NOTICE,
  KEPT_AFTER_LINK_NOTICE,
  keepPreviousSource,
  type KeepResult,
} from './previous-source'
import type {
  Engine,
  Example,
  KeyValueStorage,
  Notice,
  Scheduler,
  Settings,
  StudioActions,
  StudioState,
  StudioStore,
} from './types'

export interface StoreDeps {
  readonly engine: Engine
  readonly storage: KeyValueStorage
  readonly scheduler: Scheduler
  readonly examples: readonly Example[]
}

/**
 * How the pen is placed when a recording completes: where the current example asks for it, or
 * (after an edit) where it was.
 */
type PenStrategy = 'example' | 'keep'

/** A cancellation token for one recording; `recordAsync` polls `aborted`. */
class RunToken {
  aborted = false
}

type Set = StoreApi<StudioStore>['setState']
type Get = StoreApi<StudioStore>['getState']

export function createStudioStore(deps: StoreDeps, startup: Startup): StoreApi<StudioStore> {
  const { storage } = deps
  let kept: KeepResult = 'not-needed'
  if (startup.sharedSource !== null) {
    // The program the link replaces is kept first, so opening a link never destroys work.
    kept = keepPreviousSource(storage, deps.examples, {
      current: storage.read(STORAGE_KEYS.source),
      delivered: storage.read(STORAGE_KEYS.sourceDelivered) !== null,
      incoming: startup.sharedSource,
    })
    // A shared program becomes the session's program, so a reload (after the link's fragment has
    // been removed) keeps it rather than reverting to the previously stored source; but not when
    // the program it replaces could not be kept.
    if (kept !== 'failed') {
      storage.write(STORAGE_KEYS.source, startup.sharedSource)
      storage.write(STORAGE_KEYS.sourceDelivered, 'true')
    }
  }
  const origin: ProgramOrigin = {
    delivered: startup.sharedSource !== null || storage.read(STORAGE_KEYS.sourceDelivered) !== null,
    persistBlocked: kept === 'failed',
  }
  return createStore<StudioStore>()((set, get) => {
    const controller = new Controller(deps, set, get, origin)
    const state = initialState(storage, deps.examples, startup)
    const notice = state.notice ?? (kept === 'kept' ? KEPT_AFTER_LINK_NOTICE : null)
    return { ...state, notice, ...controller.actions() }
  })
}

/** Where the editor's program came from, as far as keeping and saving it are concerned. */
interface ProgramOrigin {
  /** It arrived with a link or an example and was not edited since (so it is not kept). */
  readonly delivered: boolean
  /** Keeping the program it replaced failed, so it is not saved over that one until edited. */
  readonly persistBlocked: boolean
}

/** Owns the timers and the in-flight recording; every state change goes through `set`. */
class Controller {
  private current: RunToken | null = null
  private penStrategy: PenStrategy = 'example'
  private autoRunTimer: number | null = null
  private persistTimer: number | null = null
  private noticeTimer: number | null = null
  private playTimer: number | null = null
  /** Steps recorded so far by the run in flight (for the status after a compile error clears). */
  private progress = 0
  /** The previous page's run never finished, so the page-load run is skipped. */
  private readonly unfinishedAtLoad: boolean
  /** See ProgramOrigin: the editor's program is unedited text from a link or an example. */
  private delivered: boolean
  /** See ProgramOrigin: saving is held back until the user edits. */
  private persistBlocked: boolean

  constructor(
    private readonly deps: StoreDeps,
    private readonly set: Set,
    private readonly get: Get,
    origin: ProgramOrigin,
  ) {
    this.unfinishedAtLoad = lastRunUnfinished(deps.storage)
    this.delivered = origin.delivered
    this.persistBlocked = origin.persistBlocked
  }

  actions(): StudioActions {
    return {
      setSource: (source) => this.setSource(source),
      loadExample: (id) => this.loadExample(id),
      run: () => this.run(),
      startup: () => this.startup(),
      extend: () => this.extend(),
      seek: (time) => this.seek(time),
      stepNav: (kind, direction) => this.stepNav(kind, direction),
      continueNav: (direction) => this.continueNav(direction),
      stepInstruction: (direction) =>
        this.seek(this.get().time + (direction === 'forward' ? 1 : -1)),
      jumpToStart: () => this.seek(0),
      jumpToEnd: () => this.seek(this.get().recording?.length ?? 0),
      togglePlay: () => (this.get().playing ? this.stopPlay() : this.startPlay()),
      stopPlay: () => this.stopPlay(),
      toggleBreakpoint: (line) => this.toggleBreakpoint(line),
      setBreakpoints: (lines) => this.setBreakpoints(lines),
      selectFrame: (uid) => this.set({ selectedFrameUid: uid }),
      jumpToOrigin: (target, label) => this.jumpToOrigin(target, label),
      setWatch: (target, label) => this.setWatch(target, label),
      updateSettings: (patch) => this.updateSettings(patch),
      dismissHint: () => {
        this.set({ hintDismissed: true })
        this.deps.storage.write(STORAGE_KEYS.hintDismissed, 'true')
      },
      clearNotice: () => this.set({ notice: null }),
      restorePreviousSource: () => this.restorePreviousSource(),
      openSharedSource: (source) => this.openSharedSource(source),
    }
  }

  // --- source and runs ----------------------------------------------------------------------

  private setSource(source: string): void {
    const exampleId = this.deps.examples.find((example) => example.source === source)?.id ?? null
    const compile = this.deps.engine.compile(source)
    this.set({
      source,
      exampleId,
      compile,
      status: compile.ok
        ? this.settledStatus()
        : { kind: 'compile-error', diagnostics: compile.diagnostics },
    })
    // An edit makes the program the user's own, and saving it is the user's choice.
    this.delivered = false
    this.persistBlocked = false
    this.schedulePersist()
    this.cancelAutoRun()
    if (compile.ok && this.get().settings.autoRun) {
      this.penStrategy = 'keep'
      this.autoRunTimer = this.deps.scheduler.setTimeout(() => {
        this.autoRunTimer = null
        void this.run()
      }, AUTO_RUN_DELAY_MS)
    }
  }

  private loadExample(id: string): void {
    const example = this.deps.examples.find((candidate) => candidate.id === id)
    if (example) this.replaceKeepingPrevious(example.source, KEPT_AFTER_EXAMPLE_NOTICE, true)
  }

  /** A share link opened in a running studio; it runs only when auto-run is on. */
  private openSharedSource(source: string): void {
    this.replaceKeepingPrevious(source, KEPT_AFTER_LINK_NOTICE, this.get().settings.autoRun)
  }

  /**
   * Replaces the program with delivered text, first keeping the user's own and saying so with
   * `notice`. When the copy cannot be stored, the new program is shown but not saved over it.
   */
  private replaceKeepingPrevious(source: string, notice: Notice, run: boolean): void {
    const current = this.get().source
    const result = keepPreviousSource(this.deps.storage, this.deps.examples, {
      current,
      delivered: this.delivered,
      incoming: source,
    })
    if (result === 'failed') this.persistBlocked = true
    this.replaceProgram(source, { delivered: true, run })
    if (result !== 'kept') return
    this.set({ previousSource: current })
    this.notify(notice)
  }

  private restorePreviousSource(): void {
    const { previousSource, source } = this.get()
    if (previousSource === null) return
    const result = keepPreviousSource(this.deps.storage, this.deps.examples, {
      current: source,
      delivered: this.delivered,
      incoming: previousSource,
    })
    if (result !== 'kept') this.deps.storage.remove(STORAGE_KEYS.previousSource)
    // The kept program is the user's own work, so it is not delivered text.
    this.replaceProgram(previousSource, { delivered: false, run: true })
    this.set({ previousSource: result === 'kept' ? source : null, notice: null })
  }

  /**
   * Puts a whole new program in the editor (example, link or restore) and saves it; then records
   * it, or (when `run` is false) only compiles it.
   */
  private replaceProgram(source: string, how: { delivered: boolean; run: boolean }): void {
    this.stopPlay()
    this.cancelAutoRun()
    this.delivered = how.delivered
    this.set({
      source,
      exampleId: this.deps.examples.find((example) => example.source === source)?.id ?? null,
      breakpoints: new Set(),
      watch: null,
      originMark: null,
    })
    this.schedulePersist()
    this.penStrategy = 'example'
    if (how.run) {
      void this.run()
      return
    }
    const compile = this.deps.engine.compile(source)
    this.set({
      compile,
      status: compile.ok
        ? this.settledStatus()
        : { kind: 'compile-error', diagnostics: compile.diagnostics },
    })
  }

  private async startup(): Promise<void> {
    // A notice that opened the page with a button gets the usual timeout from now.
    const { notice } = this.get()
    if (notice?.action !== undefined) this.notify(notice)
    if (!this.unfinishedAtLoad) return this.run()
    // Show the program (and its diagnostics) but do not run it again: it may freeze the tab anew.
    const compile = this.deps.engine.compile(this.get().source)
    this.set({
      compile,
      status: compile.ok
        ? { kind: 'idle' }
        : { kind: 'compile-error', diagnostics: compile.diagnostics },
    })
  }

  private async run(): Promise<void> {
    this.cancelAutoRun()
    const { source, settings, notice } = this.get()
    const compile = this.deps.engine.compile(source)
    if (!compile.ok) {
      this.set({ compile, status: { kind: 'compile-error', diagnostics: compile.diagnostics } })
      return
    }
    if (this.current) this.current.aborted = true
    const token = this.beginRecording(0)
    this.set({
      compile,
      status: { kind: 'recording', progress: 0 },
      originMark: null,
      notice: notice?.text === UNFINISHED_RUN_NOTICE ? null : notice,
    })
    const recording = await this.deps.engine.recordAsync(compile.program, {
      maxSteps: settings.maxSteps,
      signal: token,
      onProgress: (progress) => this.reportProgress(token, progress),
    })
    if (!this.finishRecording(token)) return
    this.stopPlay()
    const previous = this.get()
    const time = this.placePen(recording)
    this.penStrategy = 'keep'
    this.set({
      recording,
      recordedSource: source,
      status: this.completedStatus(),
      time,
      selectedFrameUid: null,
      watch: previous.recordedSource === source ? previous.watch : null,
      originMark: null,
    })
    this.clearRunMarkAfterDisplay()
  }

  private placePen(recording: Recording): number {
    if (this.penStrategy === 'keep') return this.keptTime(recording.length)
    const example = this.deps.examples.find((candidate) => candidate.id === this.get().exampleId)
    return penTime(recording, example?.pen ?? 'peak')
  }

  /** After an edit, keep the pen where it was (or at the end if it was at the end). */
  private keptTime(length: number): number {
    const { recording, time } = this.get()
    if (!recording || time >= recording.length) return length
    return Math.min(time, length)
  }

  private async extend(): Promise<void> {
    const { recording, settings } = this.get()
    if (
      !recording ||
      (recording.outcome.kind !== 'step-limit' && recording.outcome.kind !== 'aborted')
    )
      return
    const token = this.beginRecording(recording.length)
    this.set({ status: { kind: 'recording', progress: recording.length } })
    const extended = await recording.extendAsync(settings.maxSteps, {
      signal: token,
      onProgress: (progress) => this.reportProgress(token, progress),
    })
    if (!this.finishRecording(token)) return
    this.set({ recording: extended, status: this.completedStatus() })
    this.clearRunMarkAfterDisplay()
  }

  /**
   * Starts tracking a recording. The storage marker is written before the VM starts, so a run that
   * freezes or crashes the tab leaves it behind and the next page load does not repeat the run.
   */
  private beginRecording(progress: number): RunToken {
    const token = new RunToken()
    this.current = token
    this.progress = progress
    this.deps.storage.write(STORAGE_KEYS.runInProgress, 'true')
    return token
  }

  /** True when `token` is still the live run; it then stops being in flight. */
  private finishRecording(token: RunToken): boolean {
    if (this.current !== token || token.aborted) return false
    this.current = null
    return true
  }

  /**
   * Removes the run marker once the new recording has been displayed. Displaying it replays the
   * program up to the pen, which can freeze the tab as surely as recording it; the timer only
   * fires after that render has finished. A run started meanwhile keeps its own marker.
   */
  private clearRunMarkAfterDisplay(): void {
    this.deps.scheduler.setTimeout(() => {
      if (this.current === null) this.deps.storage.remove(STORAGE_KEYS.runInProgress)
    }, 0)
  }

  private reportProgress(token: RunToken, progress: number): void {
    if (this.current !== token) return
    this.progress = progress
    // A compile error typed while recording keeps the status line until the source compiles.
    if (!this.compileFailed()) this.set({ status: { kind: 'recording', progress } })
  }

  private compileFailed(): boolean {
    return this.get().compile?.ok === false
  }

  /** The status once a recording lands: ready, unless the newest source no longer compiles. */
  private completedStatus(): StudioState['status'] {
    return this.compileFailed() ? this.get().status : { kind: 'ready' }
  }

  private settledStatus(): StudioState['status'] {
    if (this.current) return { kind: 'recording', progress: this.progress }
    return this.get().recording ? { kind: 'ready' } : { kind: 'idle' }
  }

  private cancelAutoRun(): void {
    if (this.autoRunTimer !== null) this.deps.scheduler.clearTimeout(this.autoRunTimer)
    this.autoRunTimer = null
  }

  /** Saves the program shortly, with whether it is delivered text (unless saving is held back). */
  private schedulePersist(): void {
    if (this.persistTimer !== null) this.deps.scheduler.clearTimeout(this.persistTimer)
    this.persistTimer = this.deps.scheduler.setTimeout(() => {
      this.persistTimer = null
      if (this.persistBlocked) return
      const { storage } = this.deps
      storage.write(STORAGE_KEYS.source, this.get().source)
      if (this.delivered) storage.write(STORAGE_KEYS.sourceDelivered, 'true')
      else storage.remove(STORAGE_KEYS.sourceDelivered)
    }, PERSIST_DELAY_MS)
  }

  // --- navigation ---------------------------------------------------------------------------

  private seek(time: number): void {
    const length = this.get().recording?.length ?? 0
    const clamped = Math.max(0, Math.min(length, Math.round(Number.isFinite(time) ? time : 0)))
    this.set({ time: clamped, selectedFrameUid: null, originMark: null })
  }

  private stepNav(kind: StepKind, direction: Direction): void {
    const { recording, time, settings } = this.get()
    if (!recording) return
    this.seek(recording.step(time, kind, direction, { justMyCode: settings.justMyCode }))
  }

  private continueNav(direction: Direction): void {
    const { recording, time, settings, breakpoints } = this.get()
    if (!recording) return
    this.seek(recording.continue(time, direction, breakpoints, { justMyCode: settings.justMyCode }))
  }

  private startPlay(): void {
    const { recording, time, settings } = this.get()
    if (!recording) return
    if (time >= recording.length) this.seek(0)
    this.set({ playing: true })
    this.schedulePlay(settings.playbackSpeed)
  }

  /** (Re)starts the playback interval at `speed` statements per second. */
  private schedulePlay(speed: number): void {
    if (this.playTimer !== null) this.deps.scheduler.clearInterval(this.playTimer)
    const interval = Math.max(16, Math.round(1000 / speed))
    this.playTimer = this.deps.scheduler.setInterval(() => this.playTick(), interval)
  }

  private playTick(): void {
    const { recording, time, settings } = this.get()
    if (!recording) return this.stopPlay()
    const next = recording.step(time, 'into', 'forward', { justMyCode: settings.justMyCode })
    this.seek(next)
    if (next >= recording.length) this.stopPlay()
  }

  private stopPlay(): void {
    if (this.playTimer !== null) this.deps.scheduler.clearInterval(this.playTimer)
    this.playTimer = null
    if (this.get().playing) this.set({ playing: false })
  }

  private toggleBreakpoint(line: number): void {
    const next = new Set(this.get().breakpoints)
    if (next.has(line)) next.delete(line)
    else next.add(line)
    this.set({ breakpoints: next })
  }

  private setBreakpoints(lines: Iterable<number>): void {
    const next = new Set([...lines].filter((line) => Number.isInteger(line) && line >= 1))
    const current = this.get().breakpoints
    if (next.size === current.size && [...next].every((line) => current.has(line))) return
    this.set({ breakpoints: next })
  }

  // --- provenance ---------------------------------------------------------------------------

  private jumpToOrigin(target: WriteTarget, label: string): void {
    const { recording, time } = this.get()
    if (!recording) return
    const event = recording.origin(target, time)
    if (!event) {
      this.notify({ text: `No earlier change to ${label} in this run`, tone: 'info' })
      return
    }
    this.seek(Math.min(event.time + 1, recording.length))
    this.set({ originMark: { time: event.time, label } })
    this.notify({ text: describeOrigin(event, label), tone: 'info' })
  }

  private setWatch(target: WriteTarget | null, label = ''): void {
    this.set({ watch: target ? { target, label, at: this.get().time } : null })
  }

  private notify(notice: Notice): void {
    if (this.noticeTimer !== null) this.deps.scheduler.clearTimeout(this.noticeTimer)
    this.set({ notice })
    this.noticeTimer = this.deps.scheduler.setTimeout(
      () => {
        this.noticeTimer = null
        if (this.get().notice === notice) this.set({ notice: null })
      },
      notice.action === undefined ? NOTICE_DURATION_MS : ACTION_NOTICE_DURATION_MS,
    )
  }

  // --- settings -----------------------------------------------------------------------------

  private updateSettings(patch: Partial<Settings>): void {
    const previous = this.get().settings
    const settings = { ...previous, ...patch }
    this.set({ settings })
    writeJson(this.deps.storage, STORAGE_KEYS.settings, settings)
    if (this.get().playing && settings.playbackSpeed !== previous.playbackSpeed) {
      this.schedulePlay(settings.playbackSpeed)
    }
  }
}

/** The status-line sentence after jumping to an origin. */
export function describeOrigin(event: ProvenanceEvent, label: string): string {
  const step = `step ${event.time.toLocaleString('en-US')}`
  switch (event.kind) {
    case 'declare':
      return `${label} was declared here (${step})`
    case 'write':
      return `${label} was set here (${step})`
    case 'alloc':
      return `${label} was created here (${step})`
    case 'delete':
      return `${label} was deleted here (${step})`
    case 'list':
      return `${label} was ${LIST_VERBS[event.op ?? 'append']} here (${step})`
  }
}

const LIST_VERBS = {
  append: 'appended',
  extend: 'added by a spread',
  insert: 'inserted',
  remove: 'shifted by a removal',
  pop: 'changed by a pop',
} as const
