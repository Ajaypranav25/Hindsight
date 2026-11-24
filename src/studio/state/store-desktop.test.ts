/** The store actions the desktop app's menus and files use (src/studio/desktop/connect.ts). */
import { describe, expect, test } from 'vitest'
import { memoryStorage } from '../lib/storage'
import { NOTICE_DURATION_MS, STORAGE_KEYS } from './defaults'
import { KEPT_AFTER_NEW_NOTICE, keptAfterFileNotice } from './previous-source'
import { ManualScheduler } from './scheduler'
import { createStudioStore } from './store'
import { scriptedEngine } from './testing'
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
]

function setup(storage: KeyValueStorage = memoryStorage()) {
  const engine = scriptedEngine()
  const scheduler = new ManualScheduler()
  const store = createStudioStore(
    { engine, scheduler, storage, examples: EXAMPLES },
    { sharedSource: null },
  )
  return { engine, scheduler, storage, store }
}

function withOwnProgram() {
  return setup(memoryStorage({ [STORAGE_KEYS.source]: 'print("mine")' }))
}

describe('opening a program file', () => {
  test('keeps the program it replaces, names the file in the notice and records the file', () => {
    // Arrange
    const { store, engine, storage, scheduler } = withOwnProgram()

    // Act
    store.getState().openProgramFile('print("from disk")\n', 'disk.sight')

    // Assert
    const state = store.getState()
    expect(state.source).toBe('print("from disk")\n')
    expect(state.previousSource).toBe('print("mine")')
    expect(state.notice).toEqual(keptAfterFileNotice('disk.sight'))
    expect(state.notice?.text).toBe('Opened disk.sight. Your previous program was kept.')
    expect(engine.recorded.map((run) => run.source)).toEqual(['print("from disk")\n'])
    scheduler.advance(1000)
    expect(storage.read(STORAGE_KEYS.source)).toBe('print("from disk")\n')
    expect(storage.read(STORAGE_KEYS.previousSource)).toBe('print("mine")')
  })

  test('only compiles the file when auto-run is off', () => {
    const { store, engine } = setup()
    store.getState().updateSettings({ autoRun: false })

    store.getState().openProgramFile('print("x")', 'x.sight')

    expect(engine.recorded).toHaveLength(0)
    expect(store.getState().compile?.ok).toBe(true)
  })

  test('an unedited file is not kept when another one replaces it (it is on disk)', () => {
    // Arrange
    const { store } = withOwnProgram()
    store.getState().openProgramFile('print("a")', 'a.sight')

    // Act
    store.getState().openProgramFile('print("b")', 'b.sight')

    // Assert
    expect(store.getState().source).toBe('print("b")')
    expect(store.getState().previousSource).toBe('print("mine")')
  })

  test('an edited file is kept when another one replaces it', () => {
    const { store } = setup()
    store.getState().openProgramFile('print("a")', 'a.sight')
    store.getState().setSource('print("a, edited")')

    store.getState().openProgramFile('print("b")', 'b.sight')

    expect(store.getState().previousSource).toBe('print("a, edited")')
    expect(store.getState().notice).toEqual(keptAfterFileNotice('b.sight'))
  })
})

describe('a new program', () => {
  test('empties the editor, keeping the user’s program to restore', () => {
    // Arrange
    const { store, engine } = withOwnProgram()

    // Act
    store.getState().newProgram()

    // Assert
    expect(store.getState().source).toBe('')
    expect(store.getState().previousSource).toBe('print("mine")')
    expect(store.getState().notice).toEqual(KEPT_AFTER_NEW_NOTICE)
    expect(engine.recorded.map((run) => run.source)).toEqual([''])
    store.getState().restorePreviousSource()
    expect(store.getState().source).toBe('print("mine")')
  })

  test('says nothing when there was nothing of the user’s to keep', () => {
    const { store } = setup()

    store.getState().newProgram()

    expect(store.getState().source).toBe('')
    expect(store.getState().previousSource).toBeNull()
    expect(store.getState().notice).toBeNull()
  })

  test('typing into the new program makes it the user’s own again', () => {
    const { store } = setup()
    store.getState().newProgram()
    store.getState().setSource('print("new work")')

    store.getState().newProgram()

    expect(store.getState().previousSource).toBe('print("new work")')
  })
})

describe('showing a notice', () => {
  test('shows it in the status line for the usual time', () => {
    const { store, scheduler } = setup()
    const notice = { text: 'Could not save: disk full', tone: 'error' } as const

    store.getState().showNotice(notice)

    expect(store.getState().notice).toEqual(notice)
    scheduler.advance(NOTICE_DURATION_MS)
    expect(store.getState().notice).toBeNull()
  })
})
