import { describe, expect, test, vi } from 'vitest'
import type { Recording } from '../../core/api-types'
import {
  compareRecordings,
  compile,
  encodeTraceFileSync,
  record,
  recordAsync,
  traceBundle,
  type TraceBundle,
} from '../../core/index'
import { memoryStorage } from '../lib/storage'
import { STORAGE_KEYS } from './defaults'
import { ManualScheduler } from './scheduler'
import { createStudioStore } from './store'
import { openedNotice, traceEditLabels } from './trace'
import type { Engine, Example } from './types'

const COUNTER = `// title: Counter
var total = 0
for i in 1..=4 {
  total += i
  print("total {total}")
}
`

const EXAMPLES: readonly Example[] = [
  { id: 'hello', title: 'Hello', summary: '', source: 'print(1)\n', outcome: 'finished', pen: 0 },
]

const realEngine: Engine = { compile, recordAsync, compare: compareRecordings }

function setup(stored: string | null = null) {
  const storage = memoryStorage(stored === null ? {} : { [STORAGE_KEYS.source]: stored })
  const scheduler = new ManualScheduler()
  const store = createStudioStore(
    { engine: realEngine, storage, scheduler, examples: EXAMPLES },
    { sharedSource: null },
  )
  return { store, storage, scheduler }
}

function recordSource(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('does not compile')
  return record(compiled.program)
}

function bundleOf(recording: Recording, time: number, base?: Recording): TraceBundle {
  const result = traceBundle({ recording, base, time, hindsightVersion: '0.3.0', title: 'Counter' })
  if (!result.ok) throw new Error(result.error)
  return result.bundle
}

function fileOf(bundle: TraceBundle): Uint8Array {
  const encoded = encodeTraceFileSync(bundle)
  if (!encoded.ok) throw new Error(encoded.error)
  return encoded.bytes
}

/** A fork of COUNTER's run with `total` set to 100 just after its second write. */
function counterWhatIf(): { base: Recording; fork: Recording; at: number } {
  const base = recordSource(COUNTER)
  const at = base.history({ kind: 'global', name: 'total' }, base.length).events[2]!.time + 1
  const result = base.fork(at, { target: { kind: 'global', name: 'total' }, value: 100 })
  if (!result.ok) throw new Error(result.error.message)
  return { base, fork: result.recording, at }
}

describe('opening a trace file', () => {
  test('shows the program, records it again and puts the pen on the saved step', async () => {
    // Arrange
    const { store } = setup('print("my own work")\n')
    const recording = recordSource(COUNTER)

    // Act
    await store.getState().openTraceFile(fileOf(bundleOf(recording, 17)))

    // Assert
    const state = store.getState()
    expect(state.source).toBe(COUNTER)
    expect(state.recordedSource).toBe(COUNTER)
    expect(state.time).toBe(17)
    expect(state.recording?.length).toBe(recording.length)
    expect(state.status).toEqual({ kind: 'ready' })
    expect(state.whatIf).toBeNull()
    expect(state.previousSource).toBe('print("my own work")\n')
    expect(state.notice).toEqual({
      text: 'Opened “Counter” at step 17. Your previous program was kept.',
      tone: 'info',
      action: 'restore-previous',
    })
  })

  test('re-applies the what-if edits and shows the what-if against the real run', async () => {
    // Arrange
    const { store } = setup()
    const { base, fork, at } = counterWhatIf()

    // Act
    await store.getState().openTraceFile(fileOf(bundleOf(fork, at + 3, base)))

    // Assert
    const state = store.getState()
    expect(state.recording?.whatIf?.edits).toEqual(fork.whatIf!.edits)
    expect(state.time).toBe(at + 3)
    expect(state.whatIf).toMatchObject({
      parentTime: at,
      edits: [{ time: at, text: 'total = 100' }],
      label: `total = 100 at step ${at}`,
    })
    expect(state.whatIf?.parent.length).toBe(base.length)
    expect(state.whatIf?.comparison.divergence).not.toBeNull()
    expect(state.notice?.text).toBe(`Opened “Counter” with 1 what-if edit at step ${at + 3}.`)
  })

  test('explains a replay that differs from the saved run', async () => {
    // Arrange
    const { store } = setup()
    const saved = bundleOf(recordSource(COUNTER), 5)
    const changed = { ...saved, source: COUNTER.replace('1..=4', '1..=3') }

    // Act
    await store.getState().openTraceFile(fileOf(changed))

    // Assert
    expect(store.getState().notice).toMatchObject({
      tone: 'error',
      text: expect.stringMatching(/^This run replays differently than when it was saved/),
    })
  })

  test('reports a file that is not a trace without touching the program', async () => {
    // Arrange
    const { store } = setup('print("keep me")\n')

    // Act
    await store.getState().openTraceFile(new TextEncoder().encode('print("hi")\n'))

    // Assert
    expect(store.getState().source).toBe('print("keep me")\n')
    expect(store.getState().notice).toEqual({
      text: 'Could not open the trace: this is not a Hindsight trace file',
      tone: 'error',
    })
  })

  test('reports a trace whose program no longer compiles', async () => {
    // Arrange
    const { store } = setup()
    const broken = { ...bundleOf(recordSource(COUNTER), 0), source: 'print(missing)\n' }

    // Act
    await store.getState().openTraceFile(fileOf(broken))

    // Assert
    expect(store.getState().notice?.text).toMatch(
      /^Could not open the trace: the program in this trace does not compile: E020/,
    )
    expect(store.getState().status.kind).toBe('compile-error')
  })

  test('a run started while the trace records wins', async () => {
    // Arrange
    const { store } = setup()
    const long = recordSource('var i = 0\nwhile i < 200000 { i += 1 }\nprint(i)\n')
    const opening = store.getState().openTraceFile(fileOf(bundleOf(long, 9)))
    await vi.waitFor(() => expect(store.getState().status.kind).toBe('recording'))

    // Act
    store.getState().setSource('print("newer")\n')
    const running = store.getState().run()
    await Promise.all([opening, running])

    // Assert
    expect(store.getState().recordedSource).toBe('print("newer")\n')
  })

  test('opening a trace supersedes a run in flight', async () => {
    // Arrange
    const { store } = setup()
    const running = store.getState().run()

    // Act
    await store.getState().openTraceFile(fileOf(bundleOf(recordSource(COUNTER), 9)))
    await running

    // Assert
    expect(store.getState().recordedSource).toBe(COUNTER)
    expect(store.getState().time).toBe(9)
  })
})

describe('trace helpers', () => {
  test('label edits by the variable they changed', () => {
    const { fork, at } = counterWhatIf()
    expect(traceEditLabels(fork)).toEqual([{ time: at, text: 'total = 100' }])
    expect(traceEditLabels(recordSource(COUNTER))).toEqual([])
  })

  test('name an untitled trace generically', () => {
    const recording = recordSource('print(1)\n')
    const bundle = { ...bundleOf(recording, 0), title: null }
    const notice = openedNotice(
      bundle,
      { ok: true, base: recording, recording, time: 0, verification: { verified: true } },
      false,
    )
    expect(notice).toEqual({ text: 'Opened the trace at step 0.', tone: 'info' })
  })
})
