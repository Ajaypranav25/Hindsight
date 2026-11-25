import { describe, expect, test } from 'vitest'
import { MAX_QUEUED } from './ready-queue'
import {
  INITIAL_REPLACE_STATE,
  replaceStep,
  replacesProgram,
  replacing,
  SAVE_BEFORE_REPLACING_MS,
  type ReplaceEffect,
  type ReplaceEvent,
  type ReplaceState,
} from './replace-guard'

type Event = ReplaceEvent<string>

/** Runs events through the replace guard, returning the effects. */
function run(events: readonly Event[], from: ReplaceState<string> = INITIAL_REPLACE_STATE) {
  let state = from
  const effects: ReplaceEffect<string>[] = events.map((event) => {
    const step = replaceStep(state, event)
    state = step.state
    return step.effect
  })
  return { state, effects }
}

const dirty: Event = { type: 'document', dirty: true, now: 0 }
const none = { type: 'none' }
const prompt = { type: 'prompt' }

function clean(now = 0): Event {
  return { type: 'document', dirty: false, now }
}

function request(name: string, held = false): Event {
  return { type: 'request', request: name, held }
}

function answer(choice: 'save' | 'discard' | 'cancel', now = 0): Event {
  return { type: 'answer', answer: choice, now }
}

function saved(now: number, ok = true): Event {
  return { type: 'save-finished', ok, now }
}

function deliver(...requests: string[]) {
  return { type: 'deliver', requests }
}

describe('replacing a program without unsaved changes', () => {
  test('goes ahead at once', () => {
    expect(run([request('a.sight'), dirty, clean(), request('b.sight')]).effects).toEqual([
      deliver('a.sight'),
      none,
      none,
      deliver('b.sight'),
    ])
  })
})

describe('replacing a program with unsaved changes', () => {
  test('asks first, and requests that come meanwhile wait with it', () => {
    const { state, effects } = run([dirty, request('a.sight'), request('b.sight')])

    expect(effects).toEqual([none, prompt, none])
    expect(state.waiting).toEqual(['a.sight', 'b.sight'])
    expect(replacing(state)).toBe(true)
  })

  test("Don't Save lets every waiting request through, in order", () => {
    const { state, effects } = run([dirty, request('a'), request('b'), answer('discard')])

    expect(effects.at(-1)).toEqual(deliver('a', 'b'))
    expect(state).toEqual({ ...INITIAL_REPLACE_STATE, dirty: true })
  })

  test('Cancel drops them, and the next request asks again', () => {
    const { effects } = run([dirty, request('a'), answer('cancel'), request('b')])

    expect(effects.slice(1)).toEqual([prompt, none, prompt])
  })

  test('Save asks the studio to save, then lets them through once saved and reported clean', () => {
    // Arrange
    const asked = run([dirty, request('a'), answer('save', 100)])

    // Act: a request comes while saving, then the save is done.
    const finished = run([request('b'), saved(200), clean(201)], asked.state)

    // Assert
    expect(asked.effects.at(-1)).toEqual({ type: 'save' })
    expect(replacing(asked.state)).toBe(true)
    expect(finished.effects).toEqual([none, none, deliver('a', 'b')])
    expect(replacing(finished.state)).toBe(false)
  })

  test('an older save that finishes first does not let them through over newer edits', () => {
    const asked = run([dirty, request('a'), answer('save')])

    const older = run([saved(10), { type: 'document', dirty: true, now: 11 }], asked.state)
    const newer = run([saved(20), clean(21)], older.state)

    expect(older.effects).toEqual([none, none])
    expect(newer.effects).toEqual([none, deliver('a')])
  })

  test('a save that finishes with the document already reported clean lets them through', () => {
    const asked = run([dirty, request('a'), answer('save')])

    expect(run([clean(5), saved(10)], asked.state).effects).toEqual([none, deliver('a')])
  })

  test('a save that fails or is cancelled drops them', () => {
    const asked = run([dirty, request('a'), answer('save')])

    const { state, effects } = run([saved(10, false), clean(11)], asked.state)

    expect(effects).toEqual([none, none])
    expect(state.phase).toBe('idle')
    expect(state.waiting).toEqual([])
  })

  test('a save that never comes, or comes too late, drops them', () => {
    // Arrange
    const asked = run([dirty, request('a'), answer('save', 0)])
    const late = SAVE_BEFORE_REPLACING_MS + 1

    // Act
    const timedOut = run(
      [
        { type: 'deadline', now: SAVE_BEFORE_REPLACING_MS },
        { type: 'deadline', now: late },
      ],
      asked.state,
    )
    const savedLate = run([saved(late), clean(late)], asked.state)
    const reportedLate = run([saved(5), clean(late)], asked.state)

    // Assert
    expect(timedOut.effects).toEqual([none, none])
    expect(timedOut.state.phase).toBe('idle')
    expect(savedLate.effects).toEqual([none, none])
    expect(reportedLate.effects).toEqual([none, none])
    expect(reportedLate.state.waiting).toEqual([])
  })

  test('answers, saves and deadlines that belong to nothing are ignored', () => {
    const effects = run([
      answer('save'),
      saved(1),
      { type: 'deadline', now: 1e12 },
      { type: 'resume' },
    ]).effects

    expect(effects).toEqual([none, none, none, none])
  })

  test('a page that reloads while saving counts as clean', () => {
    const asked = run([dirty, request('a'), answer('save')])

    const { effects } = run([saved(10), { type: 'page-reset', now: 11 }], asked.state)

    expect(effects).toEqual([none, deliver('a')])
  })

  test('only the latest requests are kept while waiting', () => {
    const many = Array.from({ length: MAX_QUEUED + 5 }, (_, index) => request(`p${index}`))

    const { state } = run([dirty, ...many])

    expect(state.waiting).toHaveLength(MAX_QUEUED)
    expect(state.waiting.at(-1)).toBe(`p${MAX_QUEUED + 4}`)
  })
})

describe('while the window is asking whether to save before closing', () => {
  test('requests wait; if the window stays open they are asked about', () => {
    const { effects } = run([dirty, request('a', true), request('b', false), { type: 'resume' }])

    expect(effects).toEqual([none, none, none, prompt])
  })

  test('if the document became clean meanwhile they go through', () => {
    const { effects } = run([dirty, request('a', true), clean(), { type: 'resume' }])

    expect(effects.at(-1)).toEqual(deliver('a'))
  })

  test('held requests do not count as replacing', () => {
    expect(replacing(run([dirty, request('a', true)]).state)).toBe(false)
  })
})

describe('menu commands', () => {
  test('only New replaces the program', () => {
    expect(replacesProgram('new')).toBe(true)
    for (const command of ['save', 'save-as', 'save-and-close'] as const)
      expect(replacesProgram(command)).toBe(false)
  })
})
