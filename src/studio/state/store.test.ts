import { describe, expect, test } from 'vitest'
import type { FrameView, ProvenanceEvent, StateView } from '../../core/api-types'
import { memoryStorage } from '../lib/storage'
import {
  ACTION_NOTICE_DURATION_MS,
  DEFAULT_SETTINGS,
  interestingTime,
  isSettings,
  NOTICE_DURATION_MS,
  penTime,
  STORAGE_KEYS,
} from './defaults'
import { KEPT_AFTER_EXAMPLE_NOTICE, KEPT_AFTER_LINK_NOTICE } from './previous-source'
import { ManualScheduler } from './scheduler'
import { currentDiagnostics, isStale, selectedFrame, visibleFrames } from './selectors'
import { UNFINISHED_RUN_NOTICE } from './initial-state'
import { createStudioStore, describeOrigin } from './store'
import { fakeRecording, scriptedEngine } from './testing'
import type { Example, KeyValueStorage } from './types'

const EXAMPLES: readonly Example[] = [
  {
    id: 'hello',
    title: 'Hello',
    summary: 's',
    source: 'print(1)\n',
    outcome: 'finished',
    pen: 'peak',
  },
  {
    id: 'loop',
    title: 'Loop',
    summary: 's',
    source: 'for i in 0..3 { print(i) }\n',
    outcome: 'finished',
    pen: 'end',
  },
]

function setup(options: { storage?: KeyValueStorage; shared?: string | null } = {}) {
  const engine = scriptedEngine()
  const scheduler = new ManualScheduler()
  const storage = options.storage ?? memoryStorage()
  const store = createStudioStore(
    { engine, scheduler, storage, examples: EXAMPLES },
    { sharedSource: options.shared ?? null },
  )
  return { engine, scheduler, storage, store }
}

describe('initial state', () => {
  test('opens the first example when nothing is stored or shared', () => {
    const { store } = setup()
    expect(store.getState().source).toBe(EXAMPLES[0]!.source)
    expect(store.getState().exampleId).toBe('hello')
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS)
    expect(store.getState().status).toEqual({ kind: 'idle' })
  })

  test('a shared program wins over the stored one', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("stored")' })
    const { store } = setup({ storage, shared: 'print("shared")' })
    expect(store.getState().source).toBe('print("shared")')
    expect(store.getState().exampleId).toBeNull()
  })

  test('restores the last session and valid settings', () => {
    const settings = { ...DEFAULT_SETTINGS, justMyCode: false, maxSteps: 500_000 }
    const storage = memoryStorage({
      [STORAGE_KEYS.source]: EXAMPLES[1]!.source,
      [STORAGE_KEYS.settings]: JSON.stringify(settings),
      [STORAGE_KEYS.hintDismissed]: 'true',
    })
    const { store } = setup({ storage })
    expect(store.getState().exampleId).toBe('loop')
    expect(store.getState().settings).toEqual(settings)
    expect(store.getState().hintDismissed).toBe(true)
  })

  test('ignores invalid stored settings', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.settings]: '{"maxSteps":7}' })
    expect(setup({ storage }).store.getState().settings).toEqual(DEFAULT_SETTINGS)
    expect(isSettings({ ...DEFAULT_SETTINGS, theme: 'neon' })).toBe(false)
    expect(isSettings(null)).toBe(false)
  })
})

describe('running', () => {
  test('records and puts the pen on the tallest peak of the first run', async () => {
    const { store, engine } = setup()
    const running = store.getState().run()
    expect(store.getState().status).toEqual({ kind: 'recording', progress: 0 })
    engine.recorded[0]!.options.onProgress?.(3)
    expect(store.getState().status).toEqual({ kind: 'recording', progress: 3 })
    await engine.resolveNext(fakeRecording({ length: 5, depths: [0, 1, 2, 2, 0] }))
    await running
    const state = store.getState()
    expect(state.status).toEqual({ kind: 'ready' })
    expect(state.recording?.length).toBe(5)
    expect(state.recordedSource).toBe(state.source)
    expect(state.time).toBe(2)
    expect(engine.recorded[0]!.options.maxSteps).toBe(DEFAULT_SETTINGS.maxSteps)
  })

  test('reports compile errors without recording', async () => {
    const { store, engine } = setup()
    store.getState().setSource('print(ERROR)')
    await store.getState().run()
    expect(store.getState().status.kind).toBe('compile-error')
    expect(engine.recorded).toHaveLength(0)
    expect(currentDiagnostics(store.getState())).toHaveLength(1)
  })

  test('auto-runs 600 ms after the last edit and restarts the delay on each edit', async () => {
    const { store, engine, scheduler } = setup()
    store.getState().setSource('print(2)')
    scheduler.advance(500)
    store.getState().setSource('print(3)')
    scheduler.advance(500)
    expect(engine.recorded).toHaveLength(0)
    scheduler.advance(100)
    expect(engine.recorded.map((r) => r.source)).toEqual(['print(3)'])
  })

  test('does not auto-run broken programs or when auto-run is off', () => {
    const { store, engine, scheduler } = setup()
    store.getState().setSource('print(ERROR)')
    scheduler.advance(1000)
    store.getState().updateSettings({ autoRun: false })
    store.getState().setSource('print(4)')
    scheduler.advance(1000)
    expect(engine.recorded).toHaveLength(0)
  })

  test('a new run aborts the one in flight and ignores its late result', async () => {
    const { store, engine } = setup()
    void store.getState().run()
    void store.getState().run()
    expect(engine.recorded[0]!.options.signal?.aborted).toBe(true)
    await engine.resolveNext(fakeRecording({ length: 99 }))
    expect(store.getState().recording).toBeNull()
    await engine.resolveNext(fakeRecording({ length: 7 }))
    expect(store.getState().recording?.length).toBe(7)
  })

  test('keeps the pen in place after an edit, or at the end if it was there', async () => {
    const { store, engine, scheduler } = setup()
    void store.getState().run()
    await engine.resolveNext(fakeRecording({ length: 10 }))
    store.getState().seek(4)
    store.getState().setSource('print(5)')
    scheduler.advance(600)
    await engine.resolveNext(fakeRecording({ length: 3 }))
    expect(store.getState().time).toBe(3)
    store.getState().setSource('print(6)')
    scheduler.advance(600)
    await engine.resolveNext(fakeRecording({ length: 20 }))
    expect(store.getState().time).toBe(20)
  })

  test('marks a recording stale while the source differs from what was recorded', async () => {
    const { store, engine } = setup()
    void store.getState().run()
    await engine.resolveNext(fakeRecording({ length: 2 }))
    expect(isStale(store.getState())).toBe(false)
    store.getState().setSource('print(ERROR)')
    expect(isStale(store.getState())).toBe(true)
  })

  test('loads an example and opens it where its pen header asks', async () => {
    const { store, engine } = setup()
    store.getState().toggleBreakpoint(3)
    store.getState().loadExample('loop')
    expect(store.getState().source).toBe(EXAMPLES[1]!.source)
    expect(store.getState().breakpoints.size).toBe(0)
    await engine.resolveNext(fakeRecording({ length: 4, depths: [0, 1, 0, 0] }))
    expect(store.getState().time).toBe(4)
    store.getState().loadExample('hello')
    await engine.resolveNext(fakeRecording({ length: 4, depths: [0, 1, 0, 0] }))
    expect(store.getState().time).toBe(1)
    store.getState().loadExample('missing')
    expect(store.getState().exampleId).toBe('hello')
  })

  test('extends a step-limited recording', async () => {
    const { store, engine } = setup()
    void store.getState().run()
    await engine.resolveNext(
      fakeRecording({ length: 5, outcome: { kind: 'step-limit', maxSteps: 5 } }),
    )
    await store.getState().extend()
    expect(store.getState().recording?.length).toBe(5 + DEFAULT_SETTINGS.maxSteps)
    expect(store.getState().status).toEqual({ kind: 'ready' })
  })

  test('persists the source shortly after edits', () => {
    const { store, storage, scheduler } = setup()
    store.getState().setSource('print(7)')
    expect(storage.read(STORAGE_KEYS.source)).toBeNull()
    scheduler.advance(400)
    expect(storage.read(STORAGE_KEYS.source)).toBe('print(7)')
  })
})

describe('navigation', () => {
  async function recorded(options: Parameters<typeof fakeRecording>[0]) {
    const context = setup()
    void context.store.getState().run()
    await context.engine.resolveNext(fakeRecording(options))
    return context
  }

  test('seek clamps and rounds', async () => {
    const { store } = await recorded({ length: 10 })
    store.getState().seek(4.6)
    expect(store.getState().time).toBe(5)
    store.getState().seek(-3)
    expect(store.getState().time).toBe(0)
    store.getState().seek(99)
    expect(store.getState().time).toBe(10)
    store.getState().seek(Number.NaN)
    expect(store.getState().time).toBe(0)
  })

  test('steps through statements in both directions', async () => {
    const { store } = await recorded({ length: 10, stmtTimes: [0, 3, 6] })
    store.getState().seek(0)
    store.getState().stepNav('into', 'forward')
    expect(store.getState().time).toBe(3)
    store.getState().stepNav('over', 'forward')
    expect(store.getState().time).toBe(6)
    store.getState().stepNav('into', 'forward')
    expect(store.getState().time).toBe(10)
    store.getState().stepNav('into', 'backward')
    expect(store.getState().time).toBe(6)
    store.getState().stepInstruction('backward')
    expect(store.getState().time).toBe(5)
    store.getState().jumpToStart()
    expect(store.getState().time).toBe(0)
    store.getState().jumpToEnd()
    expect(store.getState().time).toBe(10)
  })

  test('continues to breakpoints', async () => {
    const hits = new Map([[4, [2, 8]]])
    const { store } = await recorded({ length: 10, breakpointHits: hits })
    store.getState().seek(0)
    store.getState().toggleBreakpoint(4)
    store.getState().continueNav('forward')
    expect(store.getState().time).toBe(2)
    store.getState().continueNav('forward')
    expect(store.getState().time).toBe(8)
    store.getState().continueNav('backward')
    expect(store.getState().time).toBe(2)
  })

  test('breakpoint toggling never mutates the previous set', async () => {
    const { store } = await recorded({ length: 3 })
    const before = store.getState().breakpoints
    store.getState().toggleBreakpoint(2)
    expect(before.has(2)).toBe(false)
    store.getState().toggleBreakpoint(2)
    expect(store.getState().breakpoints.has(2)).toBe(false)
  })

  test('plays forward statement by statement and stops at the end', async () => {
    const { store, scheduler } = await recorded({ length: 6, stmtTimes: [0, 2, 4] })
    store.getState().updateSettings({ playbackSpeed: 10 })
    store.getState().seek(0)
    store.getState().togglePlay()
    expect(store.getState().playing).toBe(true)
    scheduler.advance(100)
    expect(store.getState().time).toBe(2)
    scheduler.advance(200)
    expect(store.getState().time).toBe(6)
    expect(store.getState().playing).toBe(false)
    expect(scheduler.pending).toBeLessThanOrEqual(1)
  })

  test('playback from the end restarts at the beginning', async () => {
    const { store } = await recorded({ length: 6 })
    store.getState().jumpToEnd()
    store.getState().togglePlay()
    expect(store.getState().time).toBe(0)
    store.getState().togglePlay()
    expect(store.getState().playing).toBe(false)
  })

  test('jumps to an origin and explains it, then clears the notice', async () => {
    const target = { kind: 'global', name: 'x' } as const
    const event: ProvenanceEvent = { time: 3, kind: 'write', target, value: 1 }
    const origins = new Map([[JSON.stringify(target), event]])
    const { store, scheduler } = await recorded({ length: 10, origins })
    store.getState().seek(9)
    store.getState().jumpToOrigin(target, 'x')
    expect(store.getState().time).toBe(4)
    expect(store.getState().originMark).toEqual({ time: 3, label: 'x' })
    expect(store.getState().notice?.text).toBe('x was set here (step 3)')
    scheduler.advance(6000)
    expect(store.getState().notice).toBeNull()
    store.getState().jumpToOrigin({ kind: 'global', name: 'y' }, 'y')
    expect(store.getState().notice?.text).toBe('No earlier change to y in this run')
    store.getState().clearNotice()
    expect(store.getState().notice).toBeNull()
  })

  test('an origin jump lands after the write, clamped to the recording', async () => {
    const target = { kind: 'global', name: 'x' } as const
    const event: ProvenanceEvent = { time: 10, kind: 'write', target, value: 1 }
    const origins = new Map([[JSON.stringify(target), event]])
    const { store } = await recorded({ length: 10, origins })
    store.getState().jumpToOrigin(target, 'x')
    expect(store.getState().time).toBe(10)
    expect(store.getState().originMark).toEqual({ time: 10, label: 'x' })
  })

  test('the origin mark clears on a later seek, run or example load', async () => {
    const target = { kind: 'global', name: 'x' } as const
    const event: ProvenanceEvent = { time: 3, kind: 'write', target, value: 1 }
    const origins = new Map([[JSON.stringify(target), event]])
    const { store, engine } = await recorded({ length: 10, origins })
    expect(store.getState().originMark).toBeNull()
    store.getState().jumpToOrigin(target, 'x')
    store.getState().stepNav('into', 'forward')
    expect(store.getState().originMark).toBeNull()

    store.getState().jumpToOrigin(target, 'x')
    void store.getState().run()
    expect(store.getState().originMark).toBeNull()
    await engine.resolveNext(fakeRecording({ length: 10, origins }))

    store.getState().jumpToOrigin(target, 'x')
    store.getState().loadExample('loop')
    expect(store.getState().originMark).toBeNull()
  })

  test('watches a binding and keeps the watch across re-runs of the same source', async () => {
    const { store, engine } = await recorded({ length: 5 })
    store.getState().seek(2)
    store.getState().setWatch({ kind: 'global', name: 'x' }, 'x')
    expect(store.getState().watch).toEqual({
      target: { kind: 'global', name: 'x' },
      label: 'x',
      at: 2,
    })
    void store.getState().run()
    await engine.resolveNext(fakeRecording({ length: 5 }))
    expect(store.getState().watch?.label).toBe('x')
    store.getState().setWatch(null)
    expect(store.getState().watch).toBeNull()
  })

  test('dismissing the hint persists', () => {
    const { store, storage } = setup()
    store.getState().dismissHint()
    expect(store.getState().hintDismissed).toBe(true)
    expect(storage.read(STORAGE_KEYS.hintDismissed)).toBe('true')
  })
})

describe("keeping the user's own program", () => {
  test('a share link keeps the stored program to restore and says so', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const { store } = setup({ storage, shared: 'print("shared")' })
    expect(store.getState().source).toBe('print("shared")')
    expect(store.getState().previousSource).toBe('print("mine")')
    expect(storage.read(STORAGE_KEYS.previousSource)).toBe('print("mine")')
    expect(store.getState().notice).toEqual(KEPT_AFTER_LINK_NOTICE)
  })

  test('restoring brings the program back and runs it; an unedited shared program is not kept', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const { store, scheduler, engine } = setup({ storage, shared: 'print("shared")' })
    store.getState().restorePreviousSource()
    expect(store.getState().source).toBe('print("mine")')
    expect(store.getState().previousSource).toBeNull()
    expect(storage.read(STORAGE_KEYS.previousSource)).toBeNull()
    expect(store.getState().notice).toBeNull()
    expect(engine.recorded).toHaveLength(1)
    scheduler.advance(400)
    expect(storage.read(STORAGE_KEYS.source)).toBe('print("mine")')
  })

  test('restoring over an edited shared program keeps the edited one in turn', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const { store } = setup({ storage, shared: 'print("shared")' })
    store.getState().setSource('print("shared, edited")')
    store.getState().restorePreviousSource()
    expect(store.getState().source).toBe('print("mine")')
    expect(store.getState().previousSource).toBe('print("shared, edited")')
  })

  test('a second link does not push out the kept program', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const { store } = setup({ storage, shared: 'print("link one")' })
    store.getState().openSharedSource('print("link two")')
    expect(store.getState().source).toBe('print("link two")')
    expect(store.getState().previousSource).toBe('print("mine")')
    expect(storage.read(STORAGE_KEYS.previousSource)).toBe('print("mine")')
  })

  test('picking an example after opening a link keeps the original program', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const { store } = setup({ storage, shared: 'print("shared")' })
    store.getState().loadExample('loop')
    expect(store.getState().previousSource).toBe('print("mine")')
  })

  test('after a reload, an unedited shared program still is not the user’s own', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const first = setup({ storage, shared: 'print("link one")' })
    first.scheduler.advance(1000)
    const reloaded = setup({ storage, shared: 'print("link two")' })
    expect(reloaded.store.getState().previousSource).toBe('print("mine")')
    expect(storage.read(STORAGE_KEYS.previousSource)).toBe('print("mine")')
  })

  test('the slot holds the most recent program the user wrote', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const { store, scheduler } = setup({ storage, shared: 'print("shared")' })
    store.getState().setSource('print("shared, edited")')
    scheduler.advance(400)
    store.getState().loadExample('loop')
    expect(store.getState().previousSource).toBe('print("shared, edited")')
  })

  test('when the kept copy cannot be stored, the program is not overwritten and nothing claims it was kept', () => {
    const backing = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const storage = {
      ...backing,
      write: (key: string, value: string) => {
        if (key !== STORAGE_KEYS.previousSource) backing.write(key, value)
      },
    }
    const { store, scheduler } = setup({ storage, shared: 'print("shared")' })
    expect(store.getState().source).toBe('print("shared")')
    expect(store.getState().notice).toBeNull()
    expect(backing.read(STORAGE_KEYS.source)).toBe('print("mine")')
    scheduler.advance(1000)
    expect(backing.read(STORAGE_KEYS.source)).toBe('print("mine")')
  })

  test('an example whose kept copy cannot be stored is shown but not saved over the program', () => {
    const backing = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const storage = {
      ...backing,
      write: (key: string, value: string) => {
        if (key !== STORAGE_KEYS.previousSource) backing.write(key, value)
      },
    }
    const { store, scheduler } = setup({ storage })
    store.getState().loadExample('loop')
    expect(store.getState().source).toBe(EXAMPLES[1]!.source)
    expect(store.getState().notice).toBeNull()
    scheduler.advance(1000)
    expect(backing.read(STORAGE_KEYS.source)).toBe('print("mine")')
  })

  test('a pasted link runs only when auto-run is on', () => {
    const { store, engine } = setup()
    store.getState().updateSettings({ autoRun: false })
    store.getState().openSharedSource('print("pasted")')
    expect(store.getState().source).toBe('print("pasted")')
    expect(engine.recorded).toHaveLength(0)
    expect(store.getState().compile?.ok).toBe(true)
    store.getState().updateSettings({ autoRun: true })
    store.getState().openSharedSource('print("pasted again")')
    expect(engine.recorded).toHaveLength(1)
  })

  test('nothing is kept when the replaced program is an unchanged example or the same text', () => {
    const fromExample = setup({
      storage: memoryStorage({ [STORAGE_KEYS.source]: EXAMPLES[1]!.source }),
      shared: 'print("shared")',
    })
    expect(fromExample.store.getState().previousSource).toBeNull()
    expect(fromExample.store.getState().notice).toBeNull()
    const same = setup({
      storage: memoryStorage({ [STORAGE_KEYS.source]: 'print("same")' }),
      shared: 'print("same")',
    })
    expect(same.store.getState().previousSource).toBeNull()
    expect(same.storage.read(STORAGE_KEYS.previousSource)).toBeNull()
  })

  test('loading an example keeps a program the user wrote and offers it back', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const { store } = setup({ storage })
    store.getState().loadExample('loop')
    expect(store.getState().source).toBe(EXAMPLES[1]!.source)
    expect(store.getState().previousSource).toBe('print("mine")')
    expect(storage.read(STORAGE_KEYS.previousSource)).toBe('print("mine")')
    expect(store.getState().notice).toEqual(KEPT_AFTER_EXAMPLE_NOTICE)
  })

  test('switching between examples keeps nothing and leaves an earlier backup alone', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.previousSource]: 'print("older")' })
    const { store } = setup({ storage })
    store.getState().loadExample('loop')
    expect(store.getState().previousSource).toBe('print("older")')
    expect(store.getState().notice).toBeNull()
  })

  test('the restore notice stays a while longer than ordinary notices, then clears', async () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const { store, scheduler } = setup({ storage, shared: 'print("shared")' })
    void store.getState().startup()
    scheduler.advance(NOTICE_DURATION_MS)
    expect(store.getState().notice).toEqual(KEPT_AFTER_LINK_NOTICE)
    scheduler.advance(ACTION_NOTICE_DURATION_MS)
    expect(store.getState().notice).toBeNull()
  })

  test('a link pasted into an open studio keeps the program it replaces, too', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' })
    const { store, scheduler, engine } = setup({ storage })
    store.getState().toggleBreakpoint(1)
    store.getState().openSharedSource('print("pasted")')
    expect(store.getState().source).toBe('print("pasted")')
    expect(store.getState().breakpoints.size).toBe(0)
    expect(engine.recorded).toHaveLength(1)
    expect(store.getState().previousSource).toBe('print("mine")')
    expect(store.getState().notice).toEqual(KEPT_AFTER_LINK_NOTICE)
    scheduler.advance(400)
    expect(storage.read(STORAGE_KEYS.source)).toBe('print("pasted")')
    expect(storage.read(STORAGE_KEYS.previousSource)).toBe('print("mine")')
  })

  test('restoring with nothing kept does nothing', () => {
    const { store, engine } = setup()
    store.getState().restorePreviousSource()
    expect(store.getState().source).toBe(EXAMPLES[0]!.source)
    expect(engine.recorded).toHaveLength(0)
  })
})

describe('review regressions', () => {
  test('a shared program is stored at once, so a reload without the fragment keeps it', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.source]: 'print("stored")' })
    setup({ storage, shared: 'print("shared")' })
    expect(storage.read(STORAGE_KEYS.source)).toBe('print("shared")')
  })

  test('marks a run in progress and clears the mark once the recording has been displayed', async () => {
    const { store, engine, storage, scheduler } = setup()
    const running = store.getState().startup()
    expect(storage.read(STORAGE_KEYS.runInProgress)).not.toBeNull()
    await engine.resolveNext(fakeRecording({ length: 3 }))
    await running
    // Displaying a recording replays the program up to the pen, which can freeze the tab as surely
    // as recording it, so the mark outlives the render that follows the run.
    expect(storage.read(STORAGE_KEYS.runInProgress)).not.toBeNull()
    scheduler.advance(0)
    expect(storage.read(STORAGE_KEYS.runInProgress)).toBeNull()
  })

  test('an extension keeps the mark until it has been displayed', async () => {
    const { store, engine, storage, scheduler } = setup()
    void store.getState().run()
    await engine.resolveNext(
      fakeRecording({ length: 5, outcome: { kind: 'step-limit', maxSteps: 5 } }),
    )
    scheduler.advance(0)
    const extending = store.getState().extend()
    expect(storage.read(STORAGE_KEYS.runInProgress)).not.toBeNull()
    await extending
    expect(storage.read(STORAGE_KEYS.runInProgress)).not.toBeNull()
    scheduler.advance(0)
    expect(storage.read(STORAGE_KEYS.runInProgress)).toBeNull()
  })

  test('an aborted run keeps the mark until its replacement completes', async () => {
    const { store, engine, storage, scheduler } = setup()
    void store.getState().run()
    void store.getState().run()
    await engine.resolveNext(fakeRecording({ length: 3 }))
    scheduler.advance(0)
    expect(storage.read(STORAGE_KEYS.runInProgress)).not.toBeNull()
    await engine.resolveNext(fakeRecording({ length: 3 }))
    scheduler.advance(0)
    expect(storage.read(STORAGE_KEYS.runInProgress)).toBeNull()
  })

  test('a run started before the previous one was displayed keeps its own mark', async () => {
    const { store, engine, storage, scheduler } = setup()
    const first = store.getState().run()
    await engine.resolveNext(fakeRecording({ length: 3 }))
    await first
    void store.getState().run()
    scheduler.advance(0)
    expect(storage.read(STORAGE_KEYS.runInProgress)).not.toBeNull()
  })

  test('does not repeat a run that never finished; Run tries again and clears the notice', async () => {
    const storage = memoryStorage({
      [STORAGE_KEYS.source]: 'print("freezes")',
      [STORAGE_KEYS.runInProgress]: 'true',
    })
    const { store, engine, scheduler } = setup({ storage })
    expect(store.getState().notice).toEqual({ text: UNFINISHED_RUN_NOTICE, tone: 'error' })
    await store.getState().startup()
    expect(engine.recorded).toHaveLength(0)
    expect(store.getState().source).toBe('print("freezes")')
    expect(store.getState().status).toEqual({ kind: 'idle' })
    const running = store.getState().run()
    expect(store.getState().notice).toBeNull()
    await engine.resolveNext(fakeRecording({ length: 2 }))
    await running
    scheduler.advance(0)
    expect(storage.read(STORAGE_KEYS.runInProgress)).toBeNull()
  })

  test('a compile error typed during a recording outlasts its progress and completion', async () => {
    const { store, engine } = setup()
    void store.getState().run()
    store.getState().setSource('print(ERROR)')
    engine.recorded[0]!.options.onProgress?.(50)
    expect(store.getState().status.kind).toBe('compile-error')
    await engine.resolveNext(fakeRecording({ length: 4 }))
    expect(store.getState().status.kind).toBe('compile-error')
    expect(store.getState().recording?.length).toBe(4)
    expect(isStale(store.getState())).toBe(true)
  })

  test('fixing the compile error while still recording shows the recording again', () => {
    const { store, engine } = setup()
    void store.getState().run()
    engine.recorded[0]!.options.onProgress?.(10)
    store.getState().setSource('print(ERROR)')
    store.getState().setSource('print(8)')
    expect(store.getState().status).toEqual({ kind: 'recording', progress: 10 })
  })

  test('setBreakpoints replaces the set and ignores invalid lines', () => {
    const { store } = setup()
    store.getState().toggleBreakpoint(3)
    store.getState().setBreakpoints([4, 9, 0, 2.5])
    expect([...store.getState().breakpoints]).toEqual([4, 9])
    const same = store.getState().breakpoints
    store.getState().setBreakpoints([9, 4])
    expect(store.getState().breakpoints).toBe(same)
  })

  test('changing the playback speed while playing restarts the interval at the new speed', async () => {
    const { store, engine, scheduler } = setup()
    void store.getState().run()
    await engine.resolveNext(fakeRecording({ length: 100 }))
    store.getState().updateSettings({ playbackSpeed: 1 })
    store.getState().seek(0)
    store.getState().togglePlay()
    scheduler.advance(1000)
    expect(store.getState().time).toBe(1)
    store.getState().updateSettings({ playbackSpeed: 10 })
    scheduler.advance(1000)
    expect(store.getState().time).toBe(11)
    expect(scheduler.pending).toBe(1)
  })
})

describe('helpers', () => {
  test('interestingTime prefers the crash, then the tallest peak, then the end', () => {
    const error = { kind: 'error', error: {} } as never
    expect(
      interestingTime(fakeRecording({ length: 4, depths: [0, 3, 0, 0], outcome: error })),
    ).toBe(4)
    expect(interestingTime(fakeRecording({ length: 4, depths: [0, 0, 0, 0] }))).toBe(4)
    expect(interestingTime(fakeRecording({ length: 4, depths: [0, 2, 1, 2] }))).toBe(1)
  })

  test('penTime honors start, end and fractions, but always opens a failed run at the failure', () => {
    const run = fakeRecording({ length: 10, depths: [0, 0, 3, 0, 0, 0, 0, 0, 0, 0] })
    expect(penTime(run, 'start')).toBe(0)
    expect(penTime(run, 'end')).toBe(10)
    expect(penTime(run, 'peak')).toBe(2)
    expect(penTime(run, 0.25)).toBe(3)
    expect(penTime(run, 7)).toBe(10)
    const failed = fakeRecording({ length: 10, outcome: { kind: 'error', error: {} } as never })
    expect(penTime(failed, 'start')).toBe(10)
  })

  test('describeOrigin names each kind of event', () => {
    const target = { kind: 'object', objectId: 1 } as const
    const at = (kind: ProvenanceEvent['kind'], op?: ProvenanceEvent['op']): ProvenanceEvent => ({
      time: 1234,
      kind,
      target,
      value: null,
      ...(op ? { op } : {}),
    })
    expect(describeOrigin(at('declare'), 'n')).toBe('n was declared here (step 1,234)')
    expect(describeOrigin(at('alloc'), 'xs')).toBe('xs was created here (step 1,234)')
    expect(describeOrigin(at('delete'), 'r.k')).toBe('r.k was deleted here (step 1,234)')
    expect(describeOrigin(at('list', 'insert'), 'xs[2]')).toBe(
      'xs[2] was inserted here (step 1,234)',
    )
  })

  test('selectors pick frames and hide library frames', () => {
    const frame = (uid: number, library: boolean) => ({ uid, library }) as unknown as FrameView
    const view = {
      frames: [frame(1, false), frame(2, true), frame(3, false)],
    } as unknown as StateView
    expect(selectedFrame(view, null)?.uid).toBe(3)
    expect(selectedFrame(view, 1)?.uid).toBe(1)
    expect(selectedFrame(view, 42)?.uid).toBe(3)
    expect(selectedFrame(null, null)).toBeNull()
    expect(visibleFrames(view, true).map((f) => f.uid)).toEqual([3, 1])
    expect(visibleFrames(view, false).map((f) => f.uid)).toEqual([3, 2, 1])
    expect(visibleFrames(null, true)).toEqual([])
  })
})
