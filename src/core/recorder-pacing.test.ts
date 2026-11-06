import { describe, expect, test } from 'vitest'
import { startSession } from './recorder'
import { MAX_CHECK_INTERVAL, SlicePacer } from './recorder-async'
import type { Pacer } from './recorder-session'
import { compileMain, testRuntime } from './testing/recording'

/** A clock that moves only when told to. */
function manualClock() {
  let now = 0
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('SlicePacer (ARCHITECTURE §7.1.7)', () => {
  test('starts by checking after every step and backs off while steps are cheap, to a cap', () => {
    const clock = manualClock()
    const pacer = new SlicePacer(8, clock.now)
    pacer.begin()
    expect(pacer.interval).toBe(1)
    const intervals: number[] = []
    for (let check = 0; check < 8; check++) {
      clock.advance(0.01)
      expect(pacer.due()).toBe(false)
      intervals.push(pacer.interval)
    }
    expect(MAX_CHECK_INTERVAL).toBe(64)
    expect(intervals).toEqual([2, 4, 8, 16, 32, 64, 64, 64])
  })

  test('checks far more often as soon as steps turn slow', () => {
    const clock = manualClock()
    const pacer = new SlicePacer(8, clock.now)
    pacer.begin()
    while (pacer.interval < MAX_CHECK_INTERVAL) {
      clock.advance(0.01)
      pacer.due()
    }
    // A batch of steps that each call a native scanning a huge list.
    clock.advance(150)
    expect(pacer.due()).toBe(true)
    expect(pacer.interval).toBe(8)
    const intervals: number[] = []
    for (const batch of [20, 2.5, 2.5]) {
      pacer.begin()
      clock.advance(batch)
      pacer.due()
      intervals.push(pacer.interval)
    }
    expect(intervals).toEqual([1, 1, 1])
  })

  test('keeps its interval while each batch takes a moderate share of the slice', () => {
    const clock = manualClock()
    const pacer = new SlicePacer(8, clock.now)
    pacer.begin()
    while (pacer.interval < 16) {
      clock.advance(0.01)
      pacer.due()
    }
    for (let check = 0; check < 5; check++) {
      clock.advance(1)
      pacer.due()
    }
    expect(pacer.interval).toBe(16)
  })

  test('ends a slice at its deadline, and the interval carries over to the next slice', () => {
    const clock = manualClock()
    const pacer = new SlicePacer(8, clock.now)
    pacer.begin()
    clock.advance(3)
    expect(pacer.due()).toBe(false)
    clock.advance(3)
    expect(pacer.due()).toBe(false)
    clock.advance(3)
    expect(pacer.due()).toBe(true)
    const carried = pacer.interval
    pacer.begin()
    expect(pacer.interval).toBe(carried)
    clock.advance(0.01)
    expect(pacer.due()).toBe(false)
  })

  test('a zero-length slice ends at every check but still backs off for cheap steps', () => {
    const clock = manualClock()
    const pacer = new SlicePacer(0, clock.now)
    for (let slice = 0; slice < 8; slice++) {
      pacer.begin()
      clock.advance(0.01)
      expect(pacer.due()).toBe(true)
    }
    expect(pacer.interval).toBe(MAX_CHECK_INTERVAL)
  })
})

describe('RecordingSession.run with a pacer', () => {
  const LOOP = 'var i = 0\nwhile i < 100000 { i = i + 1 }'

  /** A pacer that answers from a script and may change its interval when asked. */
  function scriptedPacer(interval: number, answers: readonly boolean[], next?: number[]): Pacer {
    let asked = 0
    const pacer = {
      interval,
      due() {
        const answer = answers[asked] ?? true
        pacer.interval = next?.[asked] ?? pacer.interval
        asked++
        return answer
      },
    }
    return pacer
  }

  function session() {
    return startSession(compileMain(LOOP), testRuntime(), { maxSteps: 1_000_000 })
  }

  test('runs exactly `interval` steps between checks', () => {
    const run = session()
    expect(run.run(scriptedPacer(3, [false, false, true]))).toBeNull()
    expect(run.currentTime).toBe(9)
  })

  test('a new interval set during a check applies from the next batch', () => {
    const run = session()
    expect(run.run(scriptedPacer(3, [false, true], [5]))).toBeNull()
    expect(run.currentTime).toBe(8)
  })

  test('every slice makes progress, even when every check says stop', () => {
    const run = session()
    const pacer = scriptedPacer(1, [])
    for (let slice = 1; slice <= 3; slice++) {
      expect(run.run(pacer)).toBeNull()
      expect(run.currentTime).toBe(slice)
    }
  })

  test('without a pacer the run goes to the end in one call', () => {
    const run = session()
    const core = run.run(null)
    expect(core?.outcome.kind).toBe('finished')
    expect(run.currentTime).toBe(core?.length)
  })
})
