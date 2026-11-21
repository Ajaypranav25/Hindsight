import { expect, test } from 'vitest'
import type { Recording } from './api-types'
import { compile, record } from './index'
import { replayAccess } from './recorder'

/**
 * Snapshot budgets (ARCHITECTURE §6.8, §7.1.4) with generous bounds for slow CI machines. Measured
 * numbers on the reference machine are in ARCHITECTURE §6.10.
 */
const RECORD_BUDGET_MS = 8000
const SEEK_BUDGET_MS = 25
const STEP_BACK_BUDGET_MS = 400
/** Structural sharing keeps the retained snapshots far below the 8,000,000-value limit. */
const RETAINED_BUDGET = 2_000_000

function recordProgram(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
  return record(compiled.program, { maxSteps: 50_000_000 })
}

/** A deterministic pseudo-random sequence of times in `0..=n`. */
function seekTimes(n: number, count: number): number[] {
  let state = 12345
  return Array.from({ length: count }, () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % (n + 1)
  })
}

function averageSeekMs(recording: Recording, count: number): number {
  const times = seekTimes(recording.length, count)
  const started = performance.now()
  for (const t of times) recording.stateAt(t)
  return (performance.now() - started) / count
}

/** The slowest single step backwards at `count` evenly spaced times, each from a fresh position. */
function slowestStepBackMs(recording: Recording, count: number): number {
  const access = replayAccess(recording)!
  let slowest = 0
  for (let i = 0; i < count; i++) {
    const t = 1 + Math.floor(((recording.length - 1) * (i + 1)) / count)
    const seeker = access.newSeeker()
    seeker.positionAt(t)
    const started = performance.now()
    seeker.positionAt(t - 1)
    slowest = Math.max(slowest, performance.now() - started)
  }
  return slowest
}

function retainedValues(recording: Recording): number {
  return replayAccess(recording)!.core.schedule.retainedValues
}

test('a 50,000-item list mutated in place records with small, shared snapshots', () => {
  const source = `var xs = []
for i in 0..50000 { push(xs, i) }
var k = 0
while k < 100000 {
  let j = k * 7919 % 50000
  xs[j] = xs[j] + 1
  k += 1
}
print(xs[0])`
  const started = performance.now()
  const recording = recordProgram(source)
  expect(performance.now() - started).toBeLessThan(RECORD_BUDGET_MS)
  expect(recording.length).toBeGreaterThan(2_000_000)
  expect(retainedValues(recording)).toBeLessThan(RETAINED_BUDGET)
  expect(averageSeekMs(recording, 100)).toBeLessThan(SEEK_BUDGET_MS)
})

test('a 50,000-field record used as a dictionary records with small, shared snapshots', () => {
  const source = `var r = {}
for i in 0..50000 { r["k" + str(i)] = i }
var k = 0
while k < 70000 {
  let key = "k" + str(k * 7919 % 50000)
  r[key] = r[key] + 1
  k += 1
}
print(r.k0)`
  const started = performance.now()
  const recording = recordProgram(source)
  expect(performance.now() - started).toBeLessThan(RECORD_BUDGET_MS)
  expect(recording.length).toBeGreaterThan(2_000_000)
  expect(retainedValues(recording)).toBeLessThan(RETAINED_BUDGET)
  expect(averageSeekMs(recording, 100)).toBeLessThan(SEEK_BUDGET_MS)
})

test('stepping back after heavy natives stays fast: the cadence counts their work', () => {
  // Each sort, slice or scan of the 100,000-item list runs within one step.
  const source = `var xs = []
for i in 0..100000 { push(xs, i * 7919 % 100003) }
var total = 0
for round in 0..25 {
  let s = sort(xs)
  total += s[round] + len(slice(xs, round)) + index_of(xs, -1)
}
let evens = filter(xs, |x| x % 2 == 0)
total += len(map(evens, |x| x * 2))
print(total)`
  const recording = recordProgram(source)
  expect(recording.outcome).toEqual({ kind: 'finished' })
  // Before the work-based cadence a single step back took more than a second here.
  expect(slowestStepBackMs(recording, 30)).toBeLessThan(STEP_BACK_BUDGET_MS)
  expect(averageSeekMs(recording, 30)).toBeLessThan(4 * SEEK_BUDGET_MS)
})
