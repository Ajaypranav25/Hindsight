/**
 * Wall-clock budgets for the strip chart's math on long runs (`npm run test:perf`; `npm test` skips
 * this file). Building runs once per recording; queries run on every frame while scrubbing.
 */
import { expect, test } from 'vitest'
import { buildEnvelope, envelope, markerColumns } from './timeline-math'

test('2,000,000 steps: builds and queries 2,000 columns quickly', () => {
  const depths = new Int32Array(2_000_000)
  for (let i = 0; i < depths.length; i++) depths[i] = (i * 7919) % 37
  const built = performance.now()
  const env = buildEnvelope(depths)
  const buildMs = performance.now() - built
  const queried = performance.now()
  const cols = envelope(env, 0, depths.length, 2000)
  const queryMs = performance.now() - queried
  expect(cols.max[0]).toBe(36)
  expect(buildMs).toBeLessThan(500)
  expect(queryMs).toBeLessThan(50)
})

test('markerColumns on a million events stays fast', () => {
  const times = Float64Array.from({ length: 1_000_000 }, (_, i) => i * 2)
  const began = performance.now()
  const cols = markerColumns(times, { start: 0, end: 2_000_000 }, 1500)
  expect(cols.length).toBe(1500)
  expect(performance.now() - began).toBeLessThan(50)
})
