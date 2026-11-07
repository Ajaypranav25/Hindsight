import { describe, expect, test } from 'vitest'
import type {
  AsyncForkOptions,
  AsyncRecordOptions,
  ForkEdit,
  ForkResult,
  Recording,
  WriteTarget,
} from '../../core/api-types'
import { memoryStorage } from '../lib/storage'
import { STORAGE_KEYS } from './defaults'
import { ManualScheduler } from './scheduler'
import { createStudioStore } from './store'
import { fakeRecording, scriptedEngine } from './testing'
import { PEN_AT_END_NOTICE, whatIfLabel, whatIfSummary } from './what-if'

const TOTAL: WriteTarget = { kind: 'global', name: 'total' }

interface ForkCall {
  readonly time: number
  readonly edit: ForkEdit
  readonly options: AsyncForkOptions | undefined
  resolve(result: ForkResult): void
}

/** A recording whose forks wait until the test resolves them. */
function forkable(length: number, calls: ForkCall[], extra: Partial<Recording> = {}): Recording {
  const base = fakeRecording({
    length,
    outputs: [{ time: 1, text: 'a' }],
    forkAsync: (time, edit, options) =>
      new Promise<ForkResult>((resolve) => calls.push({ time, edit, options, resolve })),
  })
  return { ...base, ...extra }
}

async function studio(sharedTime: number | null = null, first?: Recording) {
  const engine = scriptedEngine()
  const scheduler = new ManualScheduler()
  const storage = memoryStorage()
  const store = createStudioStore(
    { engine, storage, scheduler, examples: [] },
    { sharedSource: 'print(1)', sharedTime },
  )
  const calls: ForkCall[] = []
  const parent = first ?? forkable(100, calls)
  void store.getState().run()
  await engine.resolveNext(parent)
  return { engine, scheduler, storage, store, calls, parent }
}

/** Starts a what-if at `time`, resolves its fork with `fork` and waits for the store. */
async function forkAt(
  context: Awaited<ReturnType<typeof studio>>,
  time: number,
  fork: Recording,
  value = 0,
) {
  const { store, calls } = context
  store.getState().seek(time)
  const done = store.getState().forkWhatIf(TOTAL, value, 'total')
  calls.at(-1)!.resolve({ ok: true, recording: fork })
  await done
}

describe('what-if mode in the store', () => {
  test('forks at the pen, shows the fork and labels the edit', async () => {
    const context = await studio()
    const { store, calls, parent, engine } = context
    const fork = fakeRecording({ length: 120 })
    store.getState().seek(40)
    const done = store.getState().forkWhatIf(TOTAL, 0, 'total')
    expect(store.getState().status).toEqual({ kind: 'recording', progress: 40 })
    expect(calls[0]).toMatchObject({ time: 40, edit: { target: TOTAL, value: 0 } })
    calls[0]!.options?.onProgress?.(70)
    expect(store.getState().status).toEqual({ kind: 'recording', progress: 70 })
    calls[0]!.resolve({ ok: true, recording: fork })
    await done
    const state = store.getState()
    expect(state.recording).toBe(fork)
    expect(state.time).toBe(40)
    expect(state.status).toEqual({ kind: 'ready' })
    expect(state.whatIf).toMatchObject({
      parent,
      parentTime: 40,
      edits: [{ time: 40, text: 'total = 0' }],
      label: 'total = 0 at step 40',
      comparison: engine.comparison,
    })
    expect(engine.compared).toEqual([[parent, fork]])
  })

  test('back to the real run restores it with its pen', async () => {
    const context = await studio()
    await forkAt(context, 40, fakeRecording({ length: 120 }))
    context.store.getState().seek(90)
    context.store.getState().leaveWhatIf()
    const state = context.store.getState()
    expect(state.recording).toBe(context.parent)
    expect(state.time).toBe(40)
    expect(state.whatIf).toBeNull()
  })

  test('a fork of a fork keeps the real run as its parent and counts its edits', async () => {
    const context = await studio()
    const calls = context.calls
    await forkAt(context, 40, forkable(120, calls))
    const second = fakeRecording({ length: 130 })
    await forkAt(context, 60, second, 7)
    const { whatIf } = context.store.getState()
    expect(whatIf?.parent).toBe(context.parent)
    expect(whatIf?.edits.map((edit) => edit.text)).toEqual(['total = 0', 'total = 7'])
    expect(whatIf?.label).toBe('2 edits')
    expect(context.engine.compared.at(-1)).toEqual([context.parent, second])
  })

  test('a fork before the earlier edit replaces it', async () => {
    const context = await studio()
    await forkAt(context, 40, forkable(120, context.calls))
    await forkAt(context, 10, fakeRecording({ length: 120 }), 5)
    expect(context.store.getState().whatIf?.edits).toEqual([{ time: 10, text: 'total = 5' }])
  })

  test('editing the source or running leaves what-if mode', async () => {
    const context = await studio()
    await forkAt(context, 40, fakeRecording({ length: 120 }))
    context.store.getState().setSource('print(2)')
    expect(context.store.getState().whatIf).toBeNull()
    expect(context.store.getState().recording).toBe(context.parent)
    await forkAt(context, 40, fakeRecording({ length: 120 }))
    void context.store.getState().run()
    expect(context.store.getState().whatIf).toBeNull()
    expect(context.store.getState().recording).toBe(context.parent)
  })

  test('a failed fork explains itself and changes nothing', async () => {
    const context = await studio()
    context.scheduler.advance(0)
    context.store.getState().seek(40)
    const done = context.store.getState().forkWhatIf(TOTAL, 0, 'total')
    context.calls[0]!.resolve({ ok: false, error: { code: 'target', message: 'boom' } })
    await done
    const state = context.store.getState()
    expect(state.notice).toEqual({ text: 'No what-if: boom', tone: 'error' })
    expect(state.status).toEqual({ kind: 'ready' })
    expect(state.recording).toBe(context.parent)
    expect(state.whatIf).toBeNull()
    // A failed fork must not leave the "run in progress" mark for the next page load.
    context.scheduler.advance(0)
    expect(context.storage.read(STORAGE_KEYS.runInProgress)).toBeNull()
  })

  test('a what-if while the edited program does not compile keeps the compile error', async () => {
    const context = await studio()
    context.store.getState().setSource('print(ERROR)')
    const before = context.store.getState().status
    expect(before.kind).toBe('compile-error')
    await forkAt(context, 40, fakeRecording({ length: 120 }))
    expect(context.store.getState().status).toEqual(before)
    expect(context.store.getState().whatIf).not.toBeNull()
  })

  test('leaving while an extension of the fork records keeps the real run', async () => {
    const context = await studio()
    let finish: (recording: Recording) => void = () => {}
    let signal: { readonly aborted: boolean } | undefined
    const limited: Recording = {
      ...fakeRecording({ length: 120, outcome: { kind: 'step-limit', maxSteps: 120 } }),
      extendAsync: (_extra: number, options?: AsyncRecordOptions) =>
        new Promise<Recording>((resolve) => {
          finish = resolve
          signal = options?.signal
        }),
    }
    await forkAt(context, 40, limited)
    const extending = context.store.getState().extend()
    context.store.getState().leaveWhatIf()
    expect(signal?.aborted).toBe(true)
    expect(context.store.getState().status).toEqual({ kind: 'ready' })
    finish(fakeRecording({ length: 300 }))
    await extending
    expect(context.store.getState().recording).toBe(context.parent)
    expect(context.store.getState().whatIf).toBeNull()
  })

  test('at the end of the run there is no future to replay', async () => {
    const context = await studio()
    context.store.getState().seek(100)
    await context.store.getState().forkWhatIf(TOTAL, 0, 'total')
    expect(context.calls).toHaveLength(0)
    expect(context.store.getState().notice).toBe(PEN_AT_END_NOTICE)
  })

  test('leaving while a fork records abandons it', async () => {
    const context = await studio()
    context.store.getState().seek(40)
    const done = context.store.getState().forkWhatIf(TOTAL, 0, 'total')
    context.store.getState().leaveWhatIf()
    expect(context.calls[0]!.options?.signal?.aborted).toBe(true)
    expect(context.store.getState().status).toEqual({ kind: 'ready' })
    context.calls[0]!.resolve({ ok: true, recording: fakeRecording({ length: 5 }) })
    await done
    expect(context.store.getState().recording).toBe(context.parent)
    expect(context.store.getState().whatIf).toBeNull()
  })

  test('extending a step-limited what-if compares the longer fork', async () => {
    const context = await studio()
    const limited = fakeRecording({ length: 120, outcome: { kind: 'step-limit', maxSteps: 120 } })
    await forkAt(context, 40, limited)
    await context.store.getState().extend()
    const { recording, whatIf } = context.store.getState()
    expect(recording).not.toBe(limited)
    expect(whatIf?.parent).toBe(context.parent)
    expect(context.engine.compared.at(-1)).toEqual([context.parent, recording])
  })
})

describe('moment links', () => {
  test('place the pen at the linked step once recorded, clamped to the run', async () => {
    expect((await studio(30)).store.getState().time).toBe(30)
    expect((await studio(500)).store.getState().time).toBe(100)
  })

  test('a moment link opened in a running studio places the pen after its run', async () => {
    const { store, engine } = await studio()
    store.getState().openSharedSource('print(3)', 7)
    await engine.resolveNext(fakeRecording({ length: 50 }))
    expect(store.getState().time).toBe(7)
  })

  test('a linked step still waiting for its run does not move the pen of another program', async () => {
    const { store, engine } = await studio()
    store.getState().updateSettings({ autoRun: false })
    store.getState().openSharedSource('print(3)', 7)
    store.getState().setSource('print(4)')
    const running = store.getState().run()
    await engine.resolveNext(fakeRecording({ length: 50 }))
    await running
    expect(store.getState().time).toBe(50)
  })
})

describe('labels', () => {
  test('one edit names it; more count them', () => {
    expect(whatIfLabel([{ time: 3500, text: 'total = 0' }])).toBe('total = 0 at step 3,500')
    expect(
      whatIfLabel([
        { time: 1, text: 'a = 1' },
        { time: 2, text: 'b = 2' },
      ]),
    ).toBe('2 edits')
  })

  test('the summary says where the futures part and how the output changed', () => {
    const parent = fakeRecording({ length: 10, outputs: [{ time: 1, text: 'a' }] })
    const fork = fakeRecording({
      length: 10,
      outputs: [
        { time: 1, text: 'b' },
        { time: 2, text: 'c' },
      ],
    })
    const whatIf = {
      parent,
      parentTime: 3,
      edits: [{ time: 3, text: 'x = 1' }],
      label: 'x = 1 at step 3',
      comparison: { divergence: 3612, lines: [], removed: 1, added: 2 },
    }
    expect(whatIfSummary(whatIf, fork)).toEqual({
      head: 'What if x = 1 at step 3',
      divergence: 'diverges at step 3,612',
      output: '2 of 2 output lines changed',
    })
    const quiet = { ...whatIf, comparison: { divergence: null, lines: [], removed: 0, added: 0 } }
    expect(whatIfSummary(quiet, parent)).toMatchObject({
      divergence: 'the futures do not diverge',
      output: 'same output',
    })
    const one = { ...whatIf, comparison: { divergence: 4, lines: [], removed: 1, added: 0 } }
    expect(whatIfSummary(one, parent).output).toBe('1 of 1 output line changed')
  })
})
