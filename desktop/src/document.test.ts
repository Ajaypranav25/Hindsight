import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  answerOf,
  closePrompt,
  closeStep,
  INITIAL_CLOSE_STATE,
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

const dirty: CloseEvent = { type: 'document', dirty: true }
const close: CloseEvent = { type: 'close-requested', now: 0 }

describe('closing a window', () => {
  test('closes at once without unsaved changes', () => {
    expect(run([close]).effects).toEqual(['none'])
    expect(run([dirty, { type: 'document', dirty: false }, close]).effects.at(-1)).toBe('none')
  })

  test('asks first with unsaved changes, and asks only once at a time', () => {
    const { effects } = run([dirty, close, close])

    expect(effects).toEqual(['none', 'prompt', 'prevent'])
  })

  test("Don't Save closes", () => {
    const { effects } = run([dirty, close, { type: 'answer', answer: 'discard', now: 0 }, close])

    expect(effects.slice(1)).toEqual(['prompt', 'close', 'none'])
  })

  test('Cancel keeps the window and stops a quit; closing again asks again', () => {
    const { effects } = run([dirty, close, { type: 'answer', answer: 'cancel', now: 0 }, close])

    expect(effects.slice(1)).toEqual(['prompt', 'stay', 'prompt'])
  })

  test('Save asks the studio to save, and closes once the save succeeds', () => {
    // Arrange
    const answered = run([dirty, close, { type: 'answer', answer: 'save', now: 1_000 }])

    // Act
    const saved = run([{ type: 'save-finished', ok: true, now: 2_000 }, close], answered.state)

    // Assert
    expect(answered.effects.at(-1)).toBe('save-and-close')
    expect(saved.effects).toEqual(['close', 'none'])
  })

  test('a cancelled or failed save keeps the window open and stops a quit', () => {
    const answered = run([dirty, close, { type: 'answer', answer: 'save', now: 0 }])

    const failed = run([{ type: 'save-finished', ok: false, now: 10 }, close], answered.state)

    expect(failed.effects).toEqual(['stay', 'prompt'])
  })

  test('while the save is under way, closing again waits for it', () => {
    const answered = run([dirty, close, { type: 'answer', answer: 'save', now: 0 }])

    expect(closeStep(answered.state, { type: 'close-requested', now: 5 }).effect).toBe('prevent')
  })

  test('a save long after Save was chosen does not close the window', () => {
    // Arrange
    const answered = run([dirty, close, { type: 'answer', answer: 'save', now: 0 }])
    const late = SAVE_AND_CLOSE_WINDOW_MS + 1

    // Act
    const saved = closeStep(answered.state, { type: 'save-finished', ok: true, now: late })
    const closedAgain = closeStep(answered.state, { type: 'close-requested', now: late })

    // Assert
    expect(saved.effect).toBe('none')
    expect(closedAgain.effect).toBe('prompt')
  })

  test('saves the user starts themselves never close the window', () => {
    expect(run([dirty, { type: 'save-finished', ok: true, now: 0 }]).effects).toEqual([
      'none',
      'none',
    ])
  })

  test('a reloaded page starts clean, but an open prompt stays open', () => {
    const { state, effects } = run([dirty, close, { type: 'page-reset' }])

    expect(effects.at(-1)).toBe('none')
    expect(state).toEqual({ ...INITIAL_CLOSE_STATE, prompting: true })
  })
})
