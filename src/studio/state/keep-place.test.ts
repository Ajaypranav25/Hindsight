import { describe, expect, test } from 'vitest'
import { compile, mapMoment, record, type MappedMoment, type Recording } from '../../core/index'
import { memoryStorage } from '../lib/storage'
import { DEFAULT_SETTINGS, isSettings, STORAGE_KEYS } from './defaults'
import { editRunOf, KEEP_PLACE_MAX_STEPS, keptPlace } from './keep-place'
import { ManualScheduler } from './scheduler'
import { createStudioStore } from './store'
import { fakeProgram, fakeRecording, scriptedEngine } from './testing'
import type { Example } from './types'

/** A stand-in recording of `source` with `length` steps. */
function run(source: string, length: number): Recording {
  return { ...fakeRecording({ length }), program: fakeProgram(source) }
}

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

const moment = (time: number): MappedMoment => ({ time, precision: 'line', call: 'f' })

describe('keptPlace: the pen after an edit', () => {
  const engine = { mapMoment: (_a: Recording, _b: Recording, t: number) => moment(t + 100) }

  test('maps the pen to the same moment of the new run', () => {
    const place = keptPlace(engine, run('a', 50), 7, run('b', 500), true)

    expect(place).toEqual({ time: 107, place: { call: 'f', precision: 'line' } })
  })

  test('a mapped moment past the new end is clamped', () => {
    expect(keptPlace(engine, run('a', 50), 7, run('b', 20), true).time).toBe(20)
  })

  test('keeps the step number with the setting off, without a mapper, or for the same program', () => {
    expect(keptPlace(engine, run('a', 50), 7, run('b', 5), false)).toEqual({ time: 5, place: null })
    expect(keptPlace({}, run('a', 50), 7, run('b', 500), true).time).toBe(7)
    expect(keptPlace(engine, run('a', 50), 7, run('a', 500), true).time).toBe(7)
  })

  test('keeps the step number for runs too long to align quickly', () => {
    const long = run('b', KEEP_PLACE_MAX_STEPS + 1)

    expect(keptPlace(engine, run('a', 50), 7, long, true).time).toBe(7)
    expect(keptPlace(engine, long, 7, run('a', 50), true).time).toBe(7)
  })

  test('a pen at the end stays at the end; without a previous run it starts at 0', () => {
    expect(keptPlace(engine, run('a', 50), 50, run('b', 80), true).time).toBe(80)
    expect(keptPlace(engine, null, 3, run('b', 80), true).time).toBe(0)
  })

  test('with the real mapper the pen stays on the same line of the same call', () => {
    const before = recorded('fn f(x) {\n  let y = x * 2\n  y\n}\nprint(f(1))\nprint(f(2))\n')
    const after = recorded(
      '// note\nfn f(x) {\n  let y = x * 2\n  y\n}\nprint(f(1))\nprint(f(2))\n',
    )
    const t = before.lineHits(2)[1]!

    const place = keptPlace({ mapMoment }, before, t, after, true)

    expect(place.time).toBe(after.lineHits(3)[1])
    expect(place.place).toEqual({ call: 'f', precision: 'line' })
  })
})

describe('editRunOf', () => {
  test('only a run of an edited program has an edit behind it', () => {
    const before = run('a', 5)
    const after = run('b', 6)

    expect(editRunOf(before, after, null)).toEqual({
      previous: before,
      recording: after,
      place: null,
    })
    expect(editRunOf(null, after, null)).toBeNull()
    expect(editRunOf(after, run('b', 6), null)).toBeNull()
  })
})

const EXAMPLES: readonly Example[] = [
  { id: 'one', title: 'One', summary: 's', source: 'print(1)\n', outcome: 'finished', pen: 'end' },
]

function setup(mapper = true) {
  const engine = scriptedEngine()
  const mapped: [number, number][] = []
  const withMapper = Object.assign(engine, {
    mapMoment: mapper
      ? (a: Recording, b: Recording, t: number) => {
          mapped.push([a.length, b.length])
          return moment(t + 1)
        }
      : undefined,
  })
  const storage = memoryStorage()
  const scheduler = new ManualScheduler()
  const store = createStudioStore(
    { engine: withMapper, storage, scheduler, examples: EXAMPLES },
    { sharedSource: null },
  )
  return { store, engine, scheduler, mapped, storage }
}

describe('the store keeps the pen’s place after an edit', () => {
  test('an edited program lands with the pen on the same moment and its edit noted', async () => {
    const { store, engine, scheduler, mapped } = setup()
    void store.getState().run()
    await engine.resolveNext(run('print(1)\n', 10))
    store.getState().seek(4)

    store.getState().setSource('print(2)\n')
    scheduler.advance(600)
    const after = run('print(2)\n', 30)
    await engine.resolveNext(after)

    const state = store.getState()
    expect(state.time).toBe(5)
    expect(mapped).toEqual([[10, 30]])
    expect(state.editRun?.recording).toBe(after)
    expect(state.editRun?.previous.length).toBe(10)
    expect(state.editRun?.place).toEqual({ call: 'f', precision: 'line' })
  })

  test('with the setting off, the step number is kept', async () => {
    const { store, engine, scheduler, mapped } = setup()
    store.getState().updateSettings({ keepPlace: false })
    void store.getState().run()
    await engine.resolveNext(run('print(1)\n', 10))
    store.getState().seek(4)

    store.getState().setSource('print(2)\n')
    scheduler.advance(600)
    await engine.resolveNext(run('print(2)\n', 30))

    expect(store.getState().time).toBe(4)
    expect(mapped).toEqual([])
    expect(store.getState().editRun?.place).toBeNull()
  })

  test('loading an example is not an edit', async () => {
    const { store, engine } = setup()
    void store.getState().run()
    await engine.resolveNext(run('print(1)\n', 10))

    store.getState().loadExample('one')
    await engine.resolveNext(run('print(1)\n', 12))

    expect(store.getState().editRun).toBeNull()
  })

  test('running the same program again is not an edit', async () => {
    const { store, engine } = setup(false)
    void store.getState().run()
    await engine.resolveNext(run('print(1)\n', 10))

    void store.getState().run()
    await engine.resolveNext(run('print(1)\n', 10))

    expect(store.getState().editRun).toBeNull()
  })
})

describe('the setting', () => {
  test('is on by default and older stored settings without it still load', () => {
    const storage = memoryStorage()
    const { keepPlace: _omitted, ...older } = { ...DEFAULT_SETTINGS, autoRun: false }
    storage.write(STORAGE_KEYS.settings, JSON.stringify(older))

    const store = createStudioStore(
      { engine: scriptedEngine(), storage, scheduler: new ManualScheduler(), examples: EXAMPLES },
      { sharedSource: null },
    )

    expect(DEFAULT_SETTINGS.keepPlace).toBe(true)
    expect(store.getState().settings).toEqual({ ...DEFAULT_SETTINGS, autoRun: false })
    expect(isSettings({ ...DEFAULT_SETTINGS, keepPlace: 'yes' })).toBe(false)
  })
})
