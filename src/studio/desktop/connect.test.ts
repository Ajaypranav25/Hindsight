import { describe, expect, test } from 'vitest'
import {
  compareRecordings,
  compile,
  encodeTraceFileSync,
  record,
  recordAsync,
  traceBundle,
} from '../../core/index'
import { memoryStorage } from '../lib/storage'
import { shareFragment } from '../lib/share'
import { NOTICE_DURATION_MS, STORAGE_KEYS } from '../state/defaults'
import { keptAfterFileNotice, KEPT_AFTER_NEW_NOTICE } from '../state/previous-source'
import { ManualScheduler } from '../state/scheduler'
import { createStudioStore } from '../state/store'
import { fakeRecording, scriptedEngine } from '../state/testing'
import type { Engine, Example } from '../state/types'
import type {
  DesktopBridge,
  DesktopCommand,
  DesktopDocumentState,
  DesktopOpenRequest,
  DesktopSaveRequest,
  DesktopSaveResult,
} from './bridge'
import { BAD_LINK_NOTICE, connectDesktop, documentState } from './connect'

const EXAMPLES: readonly Example[] = [
  { id: 'hello', title: 'Hello', summary: 's', source: 'print(1)\n', outcome: 'finished', pen: 0 },
]

interface PendingSave {
  readonly request: DesktopSaveRequest
  resolve(result: DesktopSaveResult): void
  reject(error: unknown): void
}

/** A bridge the test drives: it emits the app's requests and settles saves by hand. */
function fakeBridge(options: { atReady?: DesktopOpenRequest } = {}) {
  const openers = new Set<(request: DesktopOpenRequest) => void>()
  const commanders = new Set<(command: DesktopCommand) => void>()
  const saves: PendingSave[] = []
  const documents: DesktopDocumentState[] = []
  const calls: string[] = []
  const open = (request: DesktopOpenRequest) => openers.forEach((listener) => listener(request))
  const bridge: DesktopBridge = {
    platform: 'linux',
    version: '0.5.0',
    onOpen(listener) {
      calls.push('onOpen')
      openers.add(listener)
      return () => openers.delete(listener)
    },
    onCommand(listener) {
      calls.push('onCommand')
      commanders.add(listener)
      return () => commanders.delete(listener)
    },
    saveProgram: (request) =>
      new Promise((resolve, reject) => saves.push({ request, resolve, reject })),
    setDocument(state) {
      calls.push('setDocument')
      documents.push(state)
    },
    ready() {
      calls.push('ready')
      // The app delivers what arrived at launch once the studio is listening.
      if (options.atReady) open(options.atReady)
    },
  }
  const command = (name: DesktopCommand) => commanders.forEach((listener) => listener(name))
  return { bridge, open, command, saves, documents, calls }
}

function setup(options: { stored?: string; atReady?: DesktopOpenRequest; engine?: Engine } = {}) {
  const engine = scriptedEngine()
  const scheduler = new ManualScheduler()
  const storage = memoryStorage(
    options.stored === undefined ? {} : { [STORAGE_KEYS.source]: options.stored },
  )
  const store = createStudioStore(
    { engine: options.engine ?? engine, scheduler, storage, examples: EXAMPLES },
    { sharedSource: null },
  )
  const app = fakeBridge({ atReady: options.atReady })
  const disconnect = connectDesktop(store, app.bridge)
  return { ...app, engine, scheduler, store, disconnect }
}

/** Lets queued saves start and settled ones finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function program(source: string, name = 'fib.sight'): DesktopOpenRequest {
  return { kind: 'program', source, path: `/work/${name}`, name }
}

describe('documentState', () => {
  test('a program without a file is never dirty', () => {
    expect(documentState(null, 'anything')).toEqual({ name: null, dirty: false })
  })

  test('a program with a file is dirty while it differs from the saved text', () => {
    const document = { path: '/a.sight', name: 'a.sight', savedSource: 'print(1)' }
    expect(documentState(document, 'print(1)')).toEqual({ name: 'a.sight', dirty: false })
    expect(documentState(document, 'print(2)')).toEqual({ name: 'a.sight', dirty: true })
  })
})

describe('connecting', () => {
  test('subscribes and reports the document before telling the app it is ready', () => {
    const { calls, documents } = setup()

    expect(calls).toEqual(['onOpen', 'onCommand', 'setDocument', 'ready'])
    expect(documents).toEqual([{ name: null, dirty: false }])
  })

  test('a file passed at launch opens as soon as the studio is ready', () => {
    // Arrange, Act
    const { store, documents } = setup({ atReady: program('print("launch")\n') })

    // Assert
    expect(store.getState().source).toBe('print("launch")\n')
    expect(documents.at(-1)).toEqual({ name: 'fib.sight', dirty: false })
  })

  test('disconnecting stops the requests and the reports', () => {
    const { store, open, documents, disconnect } = setup()

    disconnect()
    open(program('print("late")'))
    store.getState().setSource('print("edited")')

    expect(store.getState().source).toBe('print("edited")')
    expect(documents).toHaveLength(1)
  })
})

describe('opening', () => {
  test('a program file replaces the program, keeping the user’s own, and becomes the document', () => {
    // Arrange
    const { store, open, documents, engine } = setup({ stored: 'print("mine")' })

    // Act
    open(program('print("fib")\n'))

    // Assert
    expect(store.getState().source).toBe('print("fib")\n')
    expect(store.getState().previousSource).toBe('print("mine")')
    expect(store.getState().notice).toEqual(keptAfterFileNotice('fib.sight'))
    expect(engine.recorded.map((run) => run.source)).toEqual(['print("fib")\n'])
    expect(documents).toEqual([
      { name: null, dirty: false },
      { name: 'fib.sight', dirty: false },
    ])
  })

  test('edits make the document dirty once, and undoing them makes it clean again', () => {
    const { store, open, documents } = setup()
    open(program('print(1)\n'))

    store.getState().setSource('print(12)\n')
    store.getState().setSource('print(123)\n')
    store.getState().seek(0)
    store.getState().setSource('print(1)\n')

    expect(documents.slice(1)).toEqual([
      { name: 'fib.sight', dirty: false },
      { name: 'fib.sight', dirty: true },
      { name: 'fib.sight', dirty: false },
    ])
  })

  test('opening another file over an edited one reports only the new file', () => {
    // Arrange
    const { store, open, documents } = setup()
    open(program('print(1)\n', 'a.sight'))
    store.getState().setSource('print("a, edited")\n')
    const before = documents.length

    // Act
    open(program('print(2)\n', 'b.sight'))

    // Assert
    expect(documents.slice(before)).toEqual([{ name: 'b.sight', dirty: false }])
    expect(store.getState().previousSource).toBe('print("a, edited")\n')
  })

  test('a link opens its program at its moment and leaves the file', async () => {
    // Arrange
    const { store, open, documents, engine } = setup()
    open(program('print(1)\n'))

    // Act
    open({ kind: 'link', fragment: shareFragment('print("linked")\n', 12)! })
    // The file's own run was superseded by the link's; only the link's lands.
    await engine.resolveNext(fakeRecording({ length: 10 }))
    await engine.resolveNext(fakeRecording({ length: 40 }))

    // Assert
    expect(store.getState().source).toBe('print("linked")\n')
    expect(store.getState().time).toBe(12)
    expect(documents.at(-1)).toEqual({ name: null, dirty: false })
  })

  test('a link that carries no program says so and changes nothing', () => {
    const { store, open, documents } = setup()
    open(program('print(1)\n'))
    const before = documents.length

    open({ kind: 'link', fragment: '#src=%%%' })

    expect(store.getState().notice).toEqual(BAD_LINK_NOTICE)
    expect(store.getState().source).toBe('print(1)\n')
    expect(documents).toHaveLength(before)
  })
})

describe('opening a trace', () => {
  const realEngine: Engine = { compile, recordAsync, compare: compareRecordings }
  const COUNTER = 'var total = 0\nfor i in 1..=3 { total += i }\nprint(total)\n'

  function traceOf(source: string): Uint8Array {
    const compiled = compile(source)
    if (!compiled.ok) throw new Error('does not compile')
    const recording = record(compiled.program)
    const bundle = traceBundle({ recording, time: 3, hindsightVersion: '0.5.0', title: null })
    if (!bundle.ok) throw new Error(bundle.error)
    const encoded = encodeTraceFileSync(bundle.bundle)
    if (!encoded.ok) throw new Error(encoded.error)
    return encoded.bytes
  }

  test('its program replaces the file’s, which the program then leaves', async () => {
    // Arrange
    const { store, open, documents } = setup({ engine: realEngine })
    open(program('print(1)\n'))

    // Act
    open({ kind: 'trace', bytes: traceOf(COUNTER), name: 'counter.sighttrace' })
    await expect.poll(() => store.getState().status.kind).toBe('ready')

    // Assert
    expect(store.getState().source).toBe(COUNTER)
    expect(store.getState().time).toBe(3)
    expect(documents.slice(1)).toEqual([
      { name: 'fib.sight', dirty: false },
      { name: null, dirty: false },
    ])
  })

  test('a file that is not a trace says so and the program keeps its file', async () => {
    const { store, open, documents } = setup({ engine: realEngine })
    open(program('print(1)\n'))

    open({ kind: 'trace', bytes: new Uint8Array([1, 2, 3]), name: 'junk.sighttrace' })
    await expect.poll(() => store.getState().notice?.tone).toBe('error')

    expect(store.getState().notice?.text).toMatch(/^Could not open the trace/)
    expect(store.getState().source).toBe('print(1)\n')
    expect(documents.at(-1)).toEqual({ name: 'fib.sight', dirty: false })
  })

  test('a trace opened from the studio’s own menu leaves the file too', async () => {
    // Arrange
    const { store, open, documents } = setup({ engine: realEngine })
    open(program('print(1)\n'))

    // Act
    await store.getState().openTraceFile(traceOf(COUNTER))

    // Assert
    expect(store.getState().source).toBe(COUNTER)
    expect(documents.at(-1)).toEqual({ name: null, dirty: false })
  })

  test('an unexpected failure is shown, not swallowed', async () => {
    const { store, open } = setup()
    store.setState({ openTraceFile: () => Promise.reject(new Error('worker died')) })

    open({ kind: 'trace', bytes: new Uint8Array(), name: 'x.sighttrace' })
    await settle()

    expect(store.getState().notice).toEqual({
      text: 'Could not open the trace: worker died',
      tone: 'error',
    })
  })
})

describe('saving', () => {
  test('Save writes the program to its file; the saved text makes it clean', async () => {
    // Arrange
    const { store, open, command, saves, documents } = setup()
    open(program('print(1)\n'))
    store.getState().setSource('print(2)\n')

    // Act
    command('save')
    await settle()
    saves[0]!.resolve({ ok: true, path: '/work/fib.sight', name: 'fib.sight' })
    await settle()

    // Assert
    expect(saves[0]!.request).toEqual({ source: 'print(2)\n', path: '/work/fib.sight' })
    expect(documents.at(-1)).toEqual({ name: 'fib.sight', dirty: false })
  })

  test('edits made while saving stay unsaved', async () => {
    const { store, open, command, saves, documents } = setup()
    open(program('print(1)\n'))
    store.getState().setSource('print(2)\n')

    command('save')
    await settle()
    store.getState().setSource('print(3)\n')
    saves[0]!.resolve({ ok: true, path: '/work/fib.sight', name: 'fib.sight' })
    await settle()

    expect(documents.at(-1)).toEqual({ name: 'fib.sight', dirty: true })
  })

  test('Save without a file asks for one, and the program then belongs to it', async () => {
    // Arrange
    const { command, saves, documents } = setup({ stored: 'print("mine")' })

    // Act
    command('save')
    await settle()
    saves[0]!.resolve({ ok: true, path: '/work/mine.sight', name: 'mine.sight' })
    await settle()

    // Assert
    expect(saves[0]!.request).toEqual({ source: 'print("mine")', path: null })
    expect(documents.at(-1)).toEqual({ name: 'mine.sight', dirty: false })
  })

  test('Save As always asks, and moves the program to the new file', async () => {
    const { open, command, saves, documents } = setup()
    open(program('print(1)\n'))

    command('save-as')
    await settle()
    saves[0]!.resolve({ ok: true, path: '/work/copy.sight', name: 'copy.sight' })
    await settle()
    command('save')
    await settle()

    expect(saves[0]!.request.path).toBeNull()
    expect(documents.at(-1)).toEqual({ name: 'copy.sight', dirty: false })
    expect(saves[1]!.request.path).toBe('/work/copy.sight')
  })

  test('save-and-close saves exactly as Save does, even with nothing to save', async () => {
    const { open, command, saves } = setup()
    open(program('print(1)\n'))

    command('save-and-close')
    await settle()

    expect(saves.map((save) => save.request)).toEqual([
      { source: 'print(1)\n', path: '/work/fib.sight' },
    ])
  })

  test('a cancelled save changes nothing and says nothing', async () => {
    const { store, command, saves, documents } = setup()

    command('save')
    await settle()
    saves[0]!.resolve({ ok: false, reason: 'cancelled' })
    await settle()

    expect(documents).toEqual([{ name: null, dirty: false }])
    expect(store.getState().notice).toBeNull()
  })

  test('a failed save shows the app’s message and keeps the program unsaved', async () => {
    // Arrange
    const { store, open, command, saves, documents, scheduler } = setup()
    open(program('print(1)\n'))
    store.getState().setSource('print(2)\n')

    // Act
    command('save')
    await settle()
    saves[0]!.resolve({ ok: false, reason: 'failed', message: 'EACCES: permission denied' })
    await settle()

    // Assert
    expect(store.getState().notice).toEqual({
      text: 'Could not save the program: EACCES: permission denied',
      tone: 'error',
    })
    expect(documents.at(-1)).toEqual({ name: 'fib.sight', dirty: true })
    scheduler.advance(NOTICE_DURATION_MS)
    expect(store.getState().notice).toBeNull()
  })

  test('a save the bridge itself rejects is reported as failed', async () => {
    const { store, command, saves } = setup()

    command('save')
    await settle()
    saves[0]!.reject(new Error('IPC channel closed'))
    await settle()

    expect(store.getState().notice?.text).toBe('Could not save the program: IPC channel closed')
  })

  test('saves run one at a time, so a second Save uses the file the first one chose', async () => {
    // Arrange
    const { command, saves } = setup({ stored: 'print("mine")' })

    // Act
    command('save')
    command('save')
    await settle()
    const startedTogether = saves.length
    saves[0]!.resolve({ ok: true, path: '/work/mine.sight', name: 'mine.sight' })
    await settle()

    // Assert
    expect(startedTogether).toBe(1)
    expect(saves[1]!.request.path).toBe('/work/mine.sight')
  })

  test('a program opened while the save dialog was up does not take the saved file', async () => {
    const { open, command, saves, documents } = setup({ stored: 'print("mine")' })

    command('save')
    await settle()
    open({ kind: 'link', fragment: shareFragment('print("linked")\n')! })
    saves[0]!.resolve({ ok: true, path: '/work/mine.sight', name: 'mine.sight' })
    await settle()

    expect(documents.at(-1)).toEqual({ name: null, dirty: false })
  })
})

describe('a new program', () => {
  test('empties the editor, keeps the user’s program and belongs to no file', () => {
    // Arrange
    const { store, open, command, documents } = setup()
    open(program('print(1)\n'))
    store.getState().setSource('print("unsaved")\n')

    // Act
    command('new')

    // Assert
    expect(store.getState().source).toBe('')
    expect(store.getState().previousSource).toBe('print("unsaved")\n')
    expect(store.getState().notice).toEqual(KEPT_AFTER_NEW_NOTICE)
    expect(documents.at(-1)).toEqual({ name: null, dirty: false })
  })
})

describe('programs the studio puts in the editor itself', () => {
  test('a gallery example loaded over a file leaves the file, so Save asks for one', async () => {
    // Arrange
    const { store, open, command, saves, documents } = setup()
    open(program('print("fib")\n'))

    // Act
    store.getState().loadExample('hello')
    command('save')
    await settle()

    // Assert: the example is not the file's text, edited.
    expect(store.getState().source).toBe('print(1)\n')
    expect(documents.at(-1)).toEqual({ name: null, dirty: false })
    expect(saves.map((save) => save.request)).toEqual([{ source: 'print(1)\n', path: null }])
  })

  test('Restore brings back a replaced file’s edits without making them another file’s', async () => {
    // Arrange: a.sight edited, then b.sight opened over it (which keeps the edits).
    const { store, open, command, saves, documents } = setup()
    open(program('print("a")\n', 'a.sight'))
    store.getState().setSource('print("a, edited")\n')
    open(program('print("b")\n', 'b.sight'))

    // Act
    store.getState().restorePreviousSource()
    command('save')
    await settle()

    // Assert: b.sight is never written with a.sight's edits.
    expect(store.getState().source).toBe('print("a, edited")\n')
    expect(documents.at(-1)).toEqual({ name: null, dirty: false })
    expect(saves.map((save) => save.request)).toEqual([
      { source: 'print("a, edited")\n', path: null },
    ])
  })

  test('typing over the whole program is an edit: the program keeps its file', () => {
    const { store, open, documents } = setup()
    open(program('print("fib")\n'))

    store.getState().setSource('print(1)\n')

    expect(documents.at(-1)).toEqual({ name: 'fib.sight', dirty: true })
  })
})
