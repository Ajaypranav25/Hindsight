import { describe, expect, test } from 'vitest'
import type { FrameView, ProvenanceEvent, StateView } from '../../core/api-types'
import { memoryStorage } from '../lib/storage'
import { DEFAULT_SETTINGS, interestingTime, isSettings, penTime, STORAGE_KEYS } from './defaults'
import { ManualScheduler } from './scheduler'
import { currentDiagnostics, isStale, selectedFrame, visibleFrames } from './selectors'
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
