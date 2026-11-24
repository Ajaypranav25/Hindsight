import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  answerOf,
  closeBusy,
  closePrompt,
  closeStep,
  INITIAL_CLOSE_STATE,
  offersReload,
  reloadPrompt,
  representedFilename,
  SAVE_AND_CLOSE_WINDOW_MS,
  windowTitle,
  type CloseEvent,
  type CloseState,
} from './document'

describe('the window title', () => {
  test('names the document, marks unsaved changes and names the app', () => {
    expect(windowTitle({ name: 'fib.sight', dirty: false })).toBe('fib.sight — Hindsight')
    expect(windowTitle({ name: 'fib.sight', dirty: true })).toBe('● fib.sight — Hindsight')
    expect(windowTitle({ name: null, dirty: false })).toBe('Hindsight')
  })

  test('macOS shows the file only while the document is that file', () => {
    const path = resolve('code', 'fib.sight')

    expect(representedFilename('fib.sight', path)).toBe(path)
    expect(representedFilename('other.sight', path)).toBe('')
    expect(representedFilename(null, path)).toBe('')
    expect(representedFilename('fib.sight', null)).toBe('')
  })
})

describe('the unsaved-changes prompt', () => {
  test('orders its buttons as each system does and maps them back to answers', () => {
    // Arrange
    const windows = closePrompt('fib.sight', 'win32')
    const mac = closePrompt(null, 'darwin')

    // Act and assert
    expect(windows.buttons).toEqual(['Save', "Don't Save", 'Cancel'])
    expect(mac.buttons).toEqual(['Save', 'Cancel', "Don't Save"])
    expect(windows.message).toContain('fib.sight')
    expect(mac.message).toContain('this program')
    for (const prompt of [windows, mac]) {
      expect(answerOf(prompt, prompt.defaultId)).toBe('save')
      expect(answerOf(prompt, prompt.cancelId)).toBe('cancel')
      expect(answerOf(prompt, prompt.buttons.indexOf("Don't Save"))).toBe('discard')
      expect(answerOf(prompt, 99)).toBe('cancel')
    }
  })
})

describe('the reload prompt', () => {
  test('names what would be lost, and Cancel is the default', () => {
    const named = reloadPrompt('fib.sight')

    expect(named.message).toBe('Reload Hindsight?')
    expect(named.detail).toBe('Your unsaved changes to fib.sight will be lost.')
    expect(named.buttons[0]).toBe('Reload')
    expect(named.buttons[named.defaultId]).toBe('Cancel')
    expect(named.buttons[named.cancelId]).toBe('Cancel')
    expect(reloadPrompt(null).detail).toContain('this program')
  })
})

/** Runs events through the close state machine, returning the effects. */
function run(events: readonly CloseEvent[], from: CloseState = INITIAL_CLOSE_STATE) {
  let state = from
  const effects = events.map((event) => {
    const step = closeStep(state, event)
    state = step.state
    return step.effect
  })
  return { state, effects }
}

const dirty: CloseEvent = { type: 'document', dirty: true, now: 0 }
const close: CloseEvent = { type: 'close-requested', now: 0 }
const discard: CloseEvent = { type: 'answer', answer: 'discard', now: 0 }
const cancel: CloseEvent = { type: 'answer', answer: 'cancel', now: 0 }

function clean(now = 0): CloseEvent {
  return { type: 'document', dirty: false, now }
}

function saved(now: number, ok = true): CloseEvent {
  return { type: 'save-finished', ok, now }
}

/** A dirty window whose user chose Save in the close prompt at time `now`. */
function savingAt(now: number) {
  return run([dirty, close, { type: 'answer', answer: 'save', now }])
}

describe('closing a window', () => {
  test('closes at once without unsaved changes', () => {
    expect(run([close]).effects).toEqual(['none'])
    expect(run([dirty, clean(), close]).effects.at(-1)).toBe('none')
  })

  test('asks first with unsaved changes, and asks only once at a time', () => {
    const { effects } = run([dirty, close, close])

    expect(effects).toEqual(['none', 'prompt', 'prevent'])
  })

  test("Don't Save closes", () => {
    const { effects } = run([dirty, close, discard, close])

    expect(effects.slice(1)).toEqual(['prompt', 'close', 'none'])
  })

  test('Cancel keeps the window and stops a quit; closing again asks again', () => {
    const { effects } = run([dirty, close, cancel, close])

    expect(effects.slice(1)).toEqual(['prompt', 'stay', 'prompt'])
  })

  test('Save asks the studio to save, and closes once saved and reported clean', () => {
    // Arrange
    const answered = savingAt(1_000)

    // Act
    const finished = run([saved(2_000), clean(2_001), close], answered.state)

    // Assert
    expect(answered.effects.at(-1)).toBe('save-and-close')
    expect(finished.effects).toEqual(['none', 'close', 'none'])
  })

  test('an older save that finishes first does not close over newer, unsaved edits', () => {
    // Arrange: a save the user started before closing is still under way when Save is chosen.
    const answered = savingAt(0)

    // Act: it finishes, and the studio still reports the newest edits unsaved; then its own save.
    const older = run([saved(10), { type: 'document', dirty: true, now: 11 }], answered.state)
    const newer = run([saved(20), clean(21)], older.state)

    // Assert
    expect(older.effects).toEqual(['none', 'none'])
    expect(newer.effects).toEqual(['none', 'close'])
  })

  test('a clean report before any save succeeded does not close; the save then does', () => {
    const answered = savingAt(0)

    const { effects } = run([clean(5), saved(10)], answered.state)

    expect(effects).toEqual(['none', 'close'])
  })

  test('a cancelled or failed save keeps the window open and stops a quit', () => {
    const answered = savingAt(0)

    const failed = run([saved(10, false), close], answered.state)

    expect(failed.effects).toEqual(['stay', 'prompt'])
  })

  test('while the save is under way, closing again waits for it', () => {
    const answered = savingAt(0)

    expect(closeStep(answered.state, { type: 'close-requested', now: 5 }).effect).toBe('prevent')
  })

  test('a save that never comes keeps the window, and the deadline stops a quit', () => {
    // Arrange
    const answered = savingAt(0)

    // Act: the timer fires just before, then just after, the deadline.
    const early = run([{ type: 'deadline', now: SAVE_AND_CLOSE_WINDOW_MS }], answered.state)
    const late = run(
      [{ type: 'deadline', now: SAVE_AND_CLOSE_WINDOW_MS + 1 }, close, close],
      early.state,
    )

    // Assert: closing again asks again.
    expect(early.effects).toEqual(['none'])
    expect(late.effects).toEqual(['stay', 'prompt', 'prevent'])
  })

  test('a save, or a clean report, after the deadline keeps the window and stops a quit', () => {
    // Arrange
    const answered = savingAt(0)
    const late = SAVE_AND_CLOSE_WINDOW_MS + 1

    // Act
    const savedLate = run([saved(late)], answered.state)
    const reportedLate = run([saved(5), clean(late)], answered.state)
    const closedAgain = closeStep(answered.state, { type: 'close-requested', now: late })

    // Assert
    expect(savedLate.effects).toEqual(['stay'])
    expect(reportedLate.effects).toEqual(['none', 'stay'])
    expect(closedAgain.effect).toBe('prompt')
  })

  test('a deadline with no save-and-close pending does nothing', () => {
    expect(run([dirty, { type: 'deadline', now: 1e12 }]).effects).toEqual(['none', 'none'])
  })

  test('saves the user starts themselves never close the window', () => {
    expect(run([dirty, saved(0), clean()]).effects).toEqual(['none', 'none', 'none'])
  })

  test('a reloaded page starts clean, but an open prompt stays open', () => {
    const { state, effects } = run([dirty, close, { type: 'page-reset' }])

    expect(effects.at(-1)).toBe('none')
    expect(state).toEqual({ ...INITIAL_CLOSE_STATE, prompting: true })
  })

  test('a page that goes away during a save-and-close abandons it, and stops a quit', () => {
    const answered = savingAt(0)

    const { state, effects } = run([{ type: 'page-reset' }, saved(5), clean(6)], answered.state)

    expect(effects).toEqual(['stay', 'none', 'none'])
    expect(state).toEqual(INITIAL_CLOSE_STATE)
  })

  test('closing while the user is asked about replacing the program keeps the window', () => {
    const replacing: CloseEvent = { type: 'close-requested', now: 0, replacing: true }

    expect(run([dirty, replacing]).effects).toEqual(['none', 'stay'])
    expect(run([replacing]).effects).toEqual(['stay'])
    // A window already closing still closes.
    expect(run([dirty, close, discard, replacing]).effects).toEqual([
      'none',
      'prompt',
      'close',
      'none',
    ])
  })
})

describe('while closing', () => {
  test('the close is busy while its prompt is open or its save is under way', () => {
    expect(closeBusy(INITIAL_CLOSE_STATE)).toBe(false)
    expect(closeBusy(run([dirty, close]).state)).toBe(true)
    expect(closeBusy(savingAt(0).state)).toBe(true)
    expect(closeBusy(run([saved(5, false)], savingAt(0).state).state)).toBe(false)
    expect(closeBusy(run([dirty, close, cancel]).state)).toBe(false)
  })

  test('a page that goes away is offered a reload, unless the window is closing', () => {
    expect(offersReload(INITIAL_CLOSE_STATE)).toBe(true)
    expect(offersReload(run([dirty]).state)).toBe(true)
    expect(offersReload(run([dirty, close]).state)).toBe(true)
    expect(offersReload(run([close]).state)).toBe(false)
    expect(offersReload(run([dirty, close, discard]).state)).toBe(false)
    expect(offersReload(run([saved(1), clean(2)], savingAt(0).state).state)).toBe(false)
  })
})
