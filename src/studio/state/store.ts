import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Direction, ProvenanceEvent, StepKind, WriteTarget } from '../../core/api-types'
import { writeJson } from '../lib/storage'
import {
  AUTO_RUN_DELAY_MS,
  interestingTime,
  NOTICE_DURATION_MS,
  PERSIST_DELAY_MS,
  STORAGE_KEYS,
} from './defaults'
import { initialState, type Startup } from './initial-state'
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

/** How the pen is placed when a recording completes. */
type PenStrategy = 'interesting' | 'keep'

/** A cancellation token for one recording; `recordAsync` polls `aborted`. */
class RunToken {
  aborted = false
}

type Set = StoreApi<StudioStore>['setState']
type Get = StoreApi<StudioStore>['getState']

export function createStudioStore(deps: StoreDeps, startup: Startup): StoreApi<StudioStore> {
  return createStore<StudioStore>()((set, get) => {
    const controller = new Controller(deps, set, get)
    return { ...initialState(deps.storage, deps.examples, startup), ...controller.actions() }
  })
}

/** Owns the timers and the in-flight recording; every state change goes through `set`. */
class Controller {
  private current: RunToken | null = null
  private penStrategy: PenStrategy = 'interesting'
  private autoRunTimer: number | null = null
  private persistTimer: number | null = null
  private noticeTimer: number | null = null
  private playTimer: number | null = null

  constructor(
    private readonly deps: StoreDeps,
    private readonly set: Set,
    private readonly get: Get,
  ) {}

  actions(): StudioActions {
    return {
      setSource: (source) => this.setSource(source),
      loadExample: (id) => this.loadExample(id),
      run: () => this.run(),
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
      selectFrame: (uid) => this.set({ selectedFrameUid: uid }),
      jumpToOrigin: (target, label) => this.jumpToOrigin(target, label),
      setWatch: (target, label) => this.setWatch(target, label),
      updateSettings: (patch) => this.updateSettings(patch),
      dismissHint: () => {
        this.set({ hintDismissed: true })
        this.deps.storage.write(STORAGE_KEYS.hintDismissed, 'true')
      },
      clearNotice: () => this.set({ notice: null }),
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
    if (!example) return
    this.stopPlay()
    this.cancelAutoRun()
    this.set({ source: example.source, exampleId: id, breakpoints: new Set(), watch: null })
    this.schedulePersist()
    this.penStrategy = 'interesting'
    void this.run()
  }

  private async run(): Promise<void> {
    this.cancelAutoRun()
    const { source, settings } = this.get()
    const compile = this.deps.engine.compile(source)
    if (!compile.ok) {
      this.set({ compile, status: { kind: 'compile-error', diagnostics: compile.diagnostics } })
      return
    }
    if (this.current) this.current.aborted = true
    const token = new RunToken()
    this.current = token
    this.set({ compile, status: { kind: 'recording', progress: 0 } })
    const recording = await this.deps.engine.recordAsync(compile.program, {
      maxSteps: settings.maxSteps,
      signal: token,
      onProgress: (progress) => {
        if (this.current === token) this.set({ status: { kind: 'recording', progress } })
      },
    })
    if (this.current !== token || token.aborted) return
    this.current = null
    this.stopPlay()
    const previous = this.get()
    const time =
      this.penStrategy === 'interesting'
        ? interestingTime(recording)
        : this.keptTime(recording.length)
    this.penStrategy = 'keep'
    this.set({
      recording,
      recordedSource: source,
      status: { kind: 'ready' },
      time,
      selectedFrameUid: null,
      watch: previous.recordedSource === source ? previous.watch : null,
    })
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
    const token = new RunToken()
    this.current = token
    this.set({ status: { kind: 'recording', progress: recording.length } })
    const extended = await recording.extendAsync(settings.maxSteps, {
      signal: token,
      onProgress: (progress) => {
        if (this.current === token) this.set({ status: { kind: 'recording', progress } })
      },
    })
    if (this.current !== token || token.aborted) return
    this.current = null
    this.set({ recording: extended, status: { kind: 'ready' } })
  }

  private settledStatus(): StudioState['status'] {
    const { status, recording } = this.get()
    if (status.kind === 'recording') return status
    return recording ? { kind: 'ready' } : { kind: 'idle' }
  }

  private cancelAutoRun(): void {
    if (this.autoRunTimer !== null) this.deps.scheduler.clearTimeout(this.autoRunTimer)
    this.autoRunTimer = null
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) this.deps.scheduler.clearTimeout(this.persistTimer)
    this.persistTimer = this.deps.scheduler.setTimeout(() => {
      this.persistTimer = null
      this.deps.storage.write(STORAGE_KEYS.source, this.get().source)
    }, PERSIST_DELAY_MS)
  }

  // --- navigation ---------------------------------------------------------------------------

  private seek(time: number): void {
    const length = this.get().recording?.length ?? 0
    const clamped = Math.max(0, Math.min(length, Math.round(Number.isFinite(time) ? time : 0)))
    this.set({ time: clamped, selectedFrameUid: null })
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
    const interval = Math.max(16, Math.round(1000 / settings.playbackSpeed))
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

  // --- provenance ---------------------------------------------------------------------------

  private jumpToOrigin(target: WriteTarget, label: string): void {
    const { recording, time } = this.get()
    if (!recording) return
    const event = recording.origin(target, time)
    if (!event) {
      this.notify({ text: `No earlier change to ${label} in this run`, tone: 'info' })
      return
    }
    this.seek(event.time)
    this.notify({ text: describeOrigin(event, label), tone: 'info' })
  }

  private setWatch(target: WriteTarget | null, label = ''): void {
    this.set({ watch: target ? { target, label, at: this.get().time } : null })
  }

  private notify(notice: Notice): void {
    if (this.noticeTimer !== null) this.deps.scheduler.clearTimeout(this.noticeTimer)
    this.set({ notice })
    this.noticeTimer = this.deps.scheduler.setTimeout(() => {
      this.noticeTimer = null
      if (this.get().notice === notice) this.set({ notice: null })
    }, NOTICE_DURATION_MS)
  }

  // --- settings -----------------------------------------------------------------------------

  private updateSettings(patch: Partial<Settings>): void {
    const settings = { ...this.get().settings, ...patch }
    this.set({ settings })
    writeJson(this.deps.storage, STORAGE_KEYS.settings, settings)
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
