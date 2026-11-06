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
    expect(store.getState().bugFinder).toEqual({ reveal: 0, session: null })
    store.getState().openBugFinder()
    expect(store.getState().bugFinder.reveal).toBe(1)
    expect(openQuestion(store)?.name).toBe('celsius')
    const session = store.getState().bugFinder.session
    store.getState().openBugFinder()
    expect(store.getState().bugFinder.reveal).toBe(2)
    expect(store.getState().bugFinder.session).toBe(session)
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
    expect(store.getState().bugFinder).toEqual({ reveal: 1, session: null })
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
    expect(store.getState().bugFinder.session?.finder.asked).toBe(0)
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
    expect(store.getState().bugFinder).toEqual({ reveal: 1, session: null })
  })
})
