import { expect, test } from 'vitest'
import { recordSource } from './testing/recording'

/**
 * Performance budget (ARCHITECTURE §7.1.6) with generous bounds for slow CI machines: the target is
 * 2 s per million recorded steps and 5 ms per seek on a typical machine.
 */
const RECORD_BUDGET_MS = 6000
const SEEK_BUDGET_MS = 15
const HEAP_SEEK_BUDGET_MS = 250

/** A deterministic pseudo-random sequence of times in `0..=n`. */
function seekTimes(n: number, count: number): number[] {
  let state = 12345
  return Array.from({ length: count }, () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % (n + 1)
  })
}

function averageSeekMs(recording: ReturnType<typeof recordSource>, count: number): number {
  const times = seekTimes(recording.length, count)
  const started = performance.now()
  for (const t of times) recording.stateAt(t)
  return (performance.now() - started) / count
}

test('a loop-heavy program records a million steps and seeks quickly', () => {
  const source = `fn step(x) { x + 1 }
var total = 0
var i = 0
while i < 50000 {
  total = total + step(i) % 7
  i += 1
}
print(total)`
  const started = performance.now()
  const recording = recordSource(source)
  const elapsed = performance.now() - started
  expect(recording.length).toBeGreaterThan(1_000_000)
  expect(recording.outcome).toEqual({ kind: 'finished' })
  expect(elapsed).toBeLessThan(RECORD_BUDGET_MS)
  expect(averageSeekMs(recording, 200)).toBeLessThan(SEEK_BUDGET_MS)
  const navStarted = performance.now()
  expect(recording.step(0, 'over', 'forward')).toBeGreaterThan(0)
  expect(recording.lineHits(5).length).toBe(50000)
  expect(performance.now() - navStarted).toBeLessThan(RECORD_BUDGET_MS)
})

test('a heap-heavy program stays within budget thanks to the cost-aware cadence', () => {
  const source = `var rs = []
for i in 0..60000 {
  push(rs, {id: i, name: "n" + str(i)})
}
print(len(rs))`
  const started = performance.now()
  const recording = recordSource(source)
  expect(performance.now() - started).toBeLessThan(RECORD_BUDGET_MS)
  expect(recording.outputs.map((o) => o.text)).toEqual(['60000'])
  expect(averageSeekMs(recording, 20)).toBeLessThan(HEAP_SEEK_BUDGET_MS)
  const view = recording.stateAt(recording.length)
  expect(view.heap.size).toBe(250)
  expect(view.heapTruncated).toBe(true)
})

test('deeply nested data is inspected without recursion', () => {
  const recording = recordSource('var xs = []\nfor i in 0..100000 {\n  xs = [xs]\n}\nprint(1)')
  const view = recording.stateAt(recording.length)
  expect(view.globals[0]?.value.kind).toBe('ref')
  expect(view.heap.size).toBe(250)
})
