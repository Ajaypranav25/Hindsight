import { describe, expect, test } from 'vitest'
import { compile, question, record, type Recording, verdict } from '../../core/index'
import { memoryStorage } from '../lib/storage'
import { liveSession } from './bug-finder'
import { ManualScheduler } from './scheduler'
import { createStudioStore } from './store'
import { scriptedEngine } from './testing'

const CELSIUS = `fn celsius(temps) {
  map(temps, |f| (f - 32) * 5 / 6)
}
print(celsius([32, 212]))
`

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

async function setup(source = CELSIUS) {
  const engine = scriptedEngine()
  const store = createStudioStore(
    { engine, scheduler: new ManualScheduler(), storage: memoryStorage(), examples: [] },
    { sharedSource: source },
  )
  const running = store.getState().run()
  const recording = recordSource(source)
  await engine.resolveNext(recording)
  await running
  return { store, engine, recording }
}

function openQuestion(store: Awaited<ReturnType<typeof setup>>['store']) {
  const { bugFinder, recording } = store.getState()
  const session = liveSession(bugFinder, recording)
  return session === null ? undefined : question(session.finder)
}

describe('the bug finder in the store', () => {
  test('opening it reveals the panel and starts an interview about the whole program', async () => {
    const { store } = await setup()
    expect(store.getState().bugFinder).toEqual({
      reveal: 0,
      focused: 0,
      session: null,
      strategy: 'divide',
      auto: true,
    })
    store.getState().openBugFinder()
    expect(store.getState().bugFinder.reveal).toBe(1)
    expect(openQuestion(store)?.name).toBe('celsius')
    const session = store.getState().bugFinder.session
    store.getState().openBugFinder()
    expect(store.getState().bugFinder.reveal).toBe(2)
    expect(store.getState().bugFinder.session).toBe(session)
  })

  test('a reveal waits until the panel has taken focus for it', async () => {
    const { store } = await setup()
    store.getState().openBugFinder()
    expect(store.getState().bugFinder).toMatchObject({ reveal: 1, focused: 0 })
    store.getState().markBugFinderFocused()
    const handled = store.getState().bugFinder
    expect(handled).toMatchObject({ reveal: 1, focused: 1 })
    store.getState().markBugFinderFocused()
    expect(store.getState().bugFinder).toBe(handled)
  })

  test('answers, undo and close', async () => {
    const { store } = await setup()
    const actions = store.getState()
    actions.openBugFinder()
    actions.answerBugFinder('wrong')
    expect(openQuestion(store)?.name).toBe('lambda')
    actions.answerBugFinder('right')
    actions.answerBugFinder('wrong')
    const session = liveSession(store.getState().bugFinder, store.getState().recording)!
    expect(verdict(session.finder)).toMatchObject({ kind: 'found', call: { name: 'lambda' } })
    actions.undoBugFinder()
    expect(openQuestion(store)?.name).toBe('lambda')
    actions.closeBugFinder()
    expect(store.getState().bugFinder.session).toBeNull()
    actions.answerBugFinder('wrong')
    actions.undoBugFinder()
    actions.closeBugFinder()
    expect(store.getState().bugFinder.session).toBeNull()
  })

  test('follows the just-my-code setting when an interview starts', async () => {
    const { store } = await setup()
    store.getState().updateSettings({ justMyCode: false })
    store.getState().setBugFinderStrategy('top-down')
    store.getState().startBugFinder()
    store.getState().answerBugFinder('wrong')
    expect(openQuestion(store)?.name).toBe('map')
  })

  test('can start from a chosen call, and ignores a step where no call begins', async () => {
    const { store, recording } = await setup()
    const entry = recording.depthSeries().findIndex((depth) => depth === 1)
    store.getState().startBugFinder(entry)
    const session = store.getState().bugFinder.session!
    expect(session.finder.start.name).toBe('celsius')
    expect(openQuestion(store)?.name).toBe('lambda')
    store.getState().closeBugFinder()
    store.getState().startBugFinder(entry + 1)
    expect(store.getState().bugFinder.session).toBeNull()
  })

  test('after a run that failed, opening only reveals the panel', async () => {
    const { store } = await setup('fn get(xs) {\n  xs[3]\n}\nprint(get([1]))\n')
    store.getState().openBugFinder()
    expect(store.getState().bugFinder).toEqual({
      reveal: 1,
      focused: 0,
      session: null,
      strategy: 'divide',
      auto: true,
    })
    store.getState().startBugFinder()
    expect(openQuestion(store)?.outcome).toBe('raised')
  })

  test('a new recording ends the interview', async () => {
    const { store, engine } = await setup()
    store.getState().openBugFinder()
    const running = store.getState().run()
    await engine.resolveNext(recordSource(CELSIUS))
    await running
    expect(openQuestion(store)).toBeUndefined()
    store.getState().answerBugFinder('wrong')
    // The finished interview is dropped, releasing the old recording and its call tree.
    expect(store.getState().bugFinder.session).toBeNull()
  })

  test('a what-if keeps an interview about the real run, and Find the bug does not replace it', async () => {
    const source =
      'var scale = 5\nfn half(x) {\n  x * scale / 10\n}\nprint(half(4))\nprint(half(8))\n'
    const { store, recording } = await setup(source)
    store.getState().openBugFinder()
    const realSession = store.getState().bugFinder.session
    expect(realSession?.recording).toBe(recording)
    store.getState().seek(Math.floor(recording.length / 2))
    await store.getState().forkWhatIf({ kind: 'global', name: 'scale' }, 10, 'scale')
    expect(store.getState().whatIf).not.toBeNull()
    expect(store.getState().bugFinder.session).toBe(realSession)
    store.getState().openBugFinder()
    expect(store.getState().bugFinder.session).toBe(realSession)
    store.getState().leaveWhatIf()
    expect(openQuestion(store)).toBeDefined()
  })

  test('no interview starts about a recording older than the program', async () => {
    const { store } = await setup()
    store.getState().setSource(CELSIUS.replace('/ 6', '/ 9'))
    store.getState().openBugFinder()
    expect(store.getState().bugFinder).toEqual({
      reveal: 1,
      focused: 0,
      session: null,
      strategy: 'divide',
      auto: true,
    })
    store.getState().startBugFinder()
    expect(store.getState().bugFinder.session).toBeNull()
  })

  test('nothing starts before the first recording', () => {
    const store = createStudioStore(
      {
        engine: scriptedEngine(),
        scheduler: new ManualScheduler(),
        storage: memoryStorage(),
        examples: [],
      },
      { sharedSource: CELSIUS },
    )
    store.getState().openBugFinder()
    expect(store.getState().bugFinder).toEqual({
      reveal: 1,
      focused: 0,
      session: null,
      strategy: 'divide',
      auto: true,
    })
  })

  test('contracts and assertions answer questions; undo hands one back to the user', async () => {
    // Arrange
    const { store } = await setup(CONTRACTS)

    // Act
    store.getState().openBugFinder()
    const automatic = liveSession(store.getState().bugFinder, store.getState().recording)!

    // Assert
    expect(verdict(automatic.finder)).toMatchObject({ kind: 'found', call: { name: 'average' } })
    expect(automatic.finder.asked).toBe(0)
    expect(automatic.finder.answeredAutomatically).toBeGreaterThan(0)
    store.getState().undoBugFinder()
    const asked = openQuestion(store)
    expect(asked).toBeDefined()
    store.getState().answerBugFinder('wrong')
    const after = liveSession(store.getState().bugFinder, store.getState().recording)!
    expect(after.finder.asked).toBe(1)
  })

  test('turning automatic answers off restarts the interview with every question for the user', async () => {
    // Arrange
    const { store } = await setup(CONTRACTS)
    store.getState().openBugFinder()

    // Act
    store.getState().setBugFinderAuto(false)

    // Assert
    const session = liveSession(store.getState().bugFinder, store.getState().recording)!
    expect(store.getState().bugFinder.auto).toBe(false)
    expect(session.oracle).toBeNull()
    expect(session.finder.answeredAutomatically).toBe(0)
    expect(openQuestion(store)).toBeDefined()
    store.getState().answerBugFinder('wrong')
    expect(
      liveSession(store.getState().bugFinder, store.getState().recording)!.finder
        .answeredAutomatically,
    ).toBe(0)
    store.getState().setBugFinderAuto(false)
    store.getState().setBugFinderAuto(true)
    expect(liveSession(store.getState().bugFinder, store.getState().recording)!.finder.asked).toBe(
      0,
    )
  })

  test('after a failed contract, opening starts the interview at once; with them off it waits', async () => {
    // Arrange
    const first = await setup(CONTRACTS)
    const second = await setup(CONTRACTS)
    second.store.getState().setBugFinderAuto(false)

    // Act
    first.store.getState().openBugFinder()
    second.store.getState().openBugFinder()

    // Assert
    expect(first.store.getState().bugFinder.session).not.toBeNull()
    expect(second.store.getState().bugFinder.session).toBeNull()
  })
})

const CONTRACTS = `fn total(xs) {
  var sum = 0
  for x in xs { sum += x }
  sum
}
fn average(xs) ensures result * len(xs) == total(xs) {
  total(xs) / (len(xs) - 1)
}
assert(total([88, 83, 79]) == 250)
print(average([88, 83, 79]))
`
