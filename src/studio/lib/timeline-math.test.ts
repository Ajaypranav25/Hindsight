import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import type { Location } from '../../core/api-types'
import { compile, record } from '../../core/index'
import {
  MIN_VISIBLE_STEPS,
  NO_DATA,
  approach,
  axisTicks,
  buildEnvelope,
  chartSpeedText,
  clampViewport,
  depthScale,
  depthToY,
  envelope,
  followTime,
  fullViewport,
  isZoomed,
  locationText,
  lowerBound,
  markerColumns,
  mergeTimes,
  minorStepFor,
  multiplesIn,
  niceStep,
  panBy,
  rangeMinMax,
  recordingFraction,
  stepAtX,
  stepValueText,
  tapeWidth,
  timeToX,
  xToTime,
  zoomAround,
} from './timeline-math'

function bruteRange(depths: ArrayLike<number>, from: number, to: number) {
  const lo = Math.max(0, Math.floor(from))
  const hi = Math.min(depths.length, Math.ceil(to))
  if (lo >= hi) return null
  let min = Infinity
  let max = -Infinity
  for (let i = lo; i < hi; i++) {
    min = Math.min(min, depths[i]!)
    max = Math.max(max, depths[i]!)
  }
  return { min, max }
}

function bruteColumns(depths: ArrayLike<number>, start: number, end: number, columns: number) {
  const min: number[] = []
  const max: number[] = []
  const span = end - start
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(start + (c * span) / columns)
    const to = Math.max(from + 1, Math.ceil(start + ((c + 1) * span) / columns))
    const r = bruteRange(depths, from, to)
    min.push(r ? r.min : NO_DATA)
    max.push(r ? r.max : NO_DATA)
  }
  return { min, max }
}

const depthArray = fc
  .array(fc.integer({ min: 0, max: 40 }), { minLength: 0, maxLength: 600 })
  .map((xs) => Int32Array.from(xs))

const location = (overrides: Partial<Location> = {}): Location => ({
  protoId: 1,
  ip: 0,
  depth: 1,
  functionName: 'fib',
  source: 'main',
  library: false,
  span: { start: 0, end: 1 },
  stmtSpan: { start: 0, end: 1 },
  line: 7,
  stmtLine: 7,
  stmtStart: true,
  opName: 'Add',
  ...overrides,
})

describe('buildEnvelope', () => {
  test('handles an empty series', () => {
    const env = buildEnvelope(new Int32Array(0))
    expect(env.length).toBe(0)
    expect(env.maxDepth).toBe(0)
    expect(rangeMinMax(env, 0, 10)).toBeNull()
    expect(Array.from(envelope(env, 0, 1, 3).max)).toEqual([NO_DATA, NO_DATA, NO_DATA])
  })

  test('builds halving levels down to one entry and keeps level 0 as the input', () => {
    const depths = Int32Array.from([0, 1, 2, 3, 2])
    const env = buildEnvelope(depths)
    expect(env.mins[0]).toBe(depths)
    expect(env.mins.map((level) => level.length)).toEqual([5, 3, 2, 1])
    expect(Array.from(env.maxs[1]!)).toEqual([1, 3, 2])
    expect(Array.from(env.mins[1]!)).toEqual([0, 2, 2])
    expect(env.maxDepth).toBe(3)
    expect(Array.from(depths)).toEqual([0, 1, 2, 3, 2])
  })

  test('rangeMinMax equals a brute-force scan for every range of a small series', () => {
    const depths = Int32Array.from([3, 0, 5, 1, 1, 4, 2, 9, 0, 6, 7])
    const env = buildEnvelope(depths)
    for (let from = -1; from <= depths.length + 1; from++) {
      for (let to = from; to <= depths.length + 2; to++) {
        expect(rangeMinMax(env, from, to)).toEqual(bruteRange(depths, from, to))
      }
    }
  })

  test('property: rangeMinMax matches brute force', () => {
    fc.assert(
      fc.property(depthArray, fc.nat(700), fc.nat(700), (depths, a, b) => {
        const env = buildEnvelope(depths)
        const from = Math.min(a, b)
        const to = Math.max(a, b)
        expect(rangeMinMax(env, from, to)).toEqual(bruteRange(depths, from, to))
      }),
      { numRuns: 300 },
    )
  })

  test('property: per-column envelope matches brute force for any view and width', () => {
    fc.assert(
      fc.property(
        depthArray,
        fc.double({ min: -20, max: 700, noNaN: true }),
        fc.double({ min: 0.5, max: 800, noNaN: true }),
        fc.integer({ min: 1, max: 300 }),
        (depths, start, span, columns) => {
          const env = buildEnvelope(depths)
          const got = envelope(env, start, start + span, columns)
          const want = bruteColumns(depths, start, start + span, columns)
          expect(Array.from(got.min)).toEqual(want.min)
          expect(Array.from(got.max)).toEqual(want.max)
        },
      ),
      { numRuns: 300 },
    )
  })

  test('zoomed far in, each step fills several columns', () => {
    const env = buildEnvelope(Int32Array.from([0, 2]))
    const cols = envelope(env, 0, 2, 4)
    expect(Array.from(cols.max)).toEqual([0, 0, 2, 2])
  })

  test('zero columns or an empty span give empty or blank results', () => {
    const env = buildEnvelope(Int32Array.from([1, 2, 3]))
    expect(envelope(env, 0, 3, 0).min.length).toBe(0)
    expect(Array.from(envelope(env, 2, 2, 2).min)).toEqual([NO_DATA, NO_DATA])
  })

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

  test('works on a real recording', () => {
    const result = compile(
      'fn f(n) {\n  if n == 0 {\n    return 0\n  }\n  f(n - 1)\n}\nprint(f(4))\n',
    )
    if (!result.ok) throw new Error('compile failed')
    const recording = record(result.program)
    const depths = recording.depthSeries()
    const env = buildEnvelope(depths)
    expect(env.length).toBe(recording.length)
    expect(env.maxDepth).toBeGreaterThanOrEqual(5)
    expect(rangeMinMax(env, 0, recording.length)?.min).toBe(0)
  })
})

describe('viewport', () => {
  test('full viewport covers the run and is never empty', () => {
    expect(fullViewport(1000)).toEqual({ start: 0, end: 1000 })
    expect(fullViewport(0)).toEqual({ start: 0, end: 1 })
  })

  test('clamp keeps the span between 50 steps and the whole run', () => {
    expect(clampViewport({ start: 10, end: 20 }, 1000)).toEqual({ start: 10, end: 60 })
    expect(clampViewport({ start: -500, end: 5000 }, 1000)).toEqual({ start: 0, end: 1000 })
    expect(clampViewport({ start: 980, end: 1080 }, 1000)).toEqual({ start: 900, end: 1000 })
    expect(clampViewport({ start: 0, end: 5 }, 20)).toEqual({ start: 0, end: 20 })
    expect(clampViewport({ start: NaN, end: NaN }, 100)).toEqual({ start: 0, end: 100 })
  })

  test('zoomAround keeps the anchor fixed on screen', () => {
    const view = { start: 0, end: 1000 }
    const zoomed = zoomAround(view, 250, 0.5, 1000)
    expect(zoomed.end - zoomed.start).toBe(500)
    expect(timeToX(250, zoomed, 100)).toBeCloseTo(timeToX(250, view, 100))
  })

  test('zoomAround stops at the minimum span and the whole run', () => {
    const tiny = zoomAround({ start: 0, end: 1000 }, 500, 0.0001, 1000)
    expect(tiny.end - tiny.start).toBe(MIN_VISIBLE_STEPS)
    const back = zoomAround(tiny, 500, 1e6, 1000)
    expect(back).toEqual({ start: 0, end: 1000 })
  })

  test('property: zooming and panning always stay inside the run', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.array(
          fc.tuple(
            fc.boolean(),
            fc.double({ min: -2, max: 2, noNaN: true }),
            fc.double({ min: 0, max: 1, noNaN: true }),
          ),
          { maxLength: 20 },
        ),
        (length, ops) => {
          let view = fullViewport(length)
          const total = Math.max(1, length)
          for (const [zoom, amount, where] of ops) {
            const anchor = view.start + where * (view.end - view.start)
            view = zoom
              ? zoomAround(view, anchor, Math.exp(amount), length)
              : panBy(view, amount * (view.end - view.start), length)
            const span = view.end - view.start
            expect(view.start).toBeGreaterThanOrEqual(0)
            expect(view.end).toBeLessThanOrEqual(total + 1e-6)
            expect(span).toBeGreaterThanOrEqual(Math.min(MIN_VISIBLE_STEPS, total) - 1e-6)
          }
        },
      ),
    )
  })

  test('panBy stops at both ends', () => {
    const view = { start: 100, end: 200 }
    expect(panBy(view, -1000, 1000)).toEqual({ start: 0, end: 100 })
    expect(panBy(view, 5000, 1000)).toEqual({ start: 900, end: 1000 })
    expect(panBy(view, 50, 1000)).toEqual({ start: 150, end: 250 })
  })

  test('isZoomed and followTime', () => {
    expect(isZoomed({ start: 0, end: 1000 }, 1000)).toBe(false)
    expect(isZoomed({ start: 0, end: 500 }, 1000)).toBe(true)
    const view = { start: 100, end: 200 }
    expect(followTime(view, 150, 1000)).toBe(view)
    expect(followTime(view, 600, 1000)).toEqual({ start: 550, end: 650 })
    expect(followTime(view, 990, 1000)).toEqual({ start: 900, end: 1000 })
  })

  test('time and x convert both ways; stepAtX rounds and clamps', () => {
    const view = { start: 100, end: 300 }
    expect(timeToX(200, view, 400)).toBe(200)
    expect(xToTime(200, view, 400)).toBe(200)
    expect(stepAtX(1, view, 400, 1000)).toBe(101)
    expect(stepAtX(-50, view, 400, 1000)).toBe(75)
    expect(stepAtX(-5000, view, 400, 1000)).toBe(0)
    expect(stepAtX(5000, view, 400, 1000)).toBe(1000)
  })
})

describe('ticks', () => {
  test('niceStep picks 1, 2 or 5 times a power of ten', () => {
    expect([0, 0.3, 1, 1.5, 2, 3, 7, 10, 11, 49, 51, 4999, 120_000].map(niceStep)).toEqual([
      1, 1, 1, 2, 2, 5, 10, 10, 20, 50, 100, 5000, 200_000,
    ])
  })

  test('property: niceStep is the smallest nice value at or above the input', () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 1e9, noNaN: true }), (raw) => {
        const step = niceStep(raw)
        expect(step).toBeGreaterThanOrEqual(raw * (1 - 1e-9))
        expect(step).toBeLessThan(raw * 2.5 + 1)
        const lead = step / 10 ** Math.floor(Math.log10(step))
        expect([1, 2, 5]).toContain(Math.round(lead))
      }),
    )
  })

  test('minor steps divide the major step and never go below one step', () => {
    expect([1, 2, 5, 10, 20, 50, 1000, 2000].map(minorStepFor)).toEqual([
      1, 1, 1, 2, 5, 10, 200, 500,
    ])
  })

  test('axisTicks labels multiples of the major step inside the view', () => {
    const axis = axisTicks({ start: 0, end: 10_000 }, 1000, 100)
    expect(axis.major).toBe(1000)
    expect(axis.minor).toBe(200)
    expect(axis.ticks.map((tick) => tick.label)).toEqual([
      '0',
      '1k',
      '2k',
      '3k',
      '4k',
      '5k',
      '6k',
      '7k',
      '8k',
      '9k',
      '10k',
    ])
    expect(axis.ticks[1]!.x).toBe(100)
  })

  test('multiplesIn respects its limit', () => {
    expect(multiplesIn(3, 21, 5)).toEqual([5, 10, 15, 20])
    expect(multiplesIn(0, 1e9, 1, 10).length).toBe(10)
  })

  test('chart speed text', () => {
    expect(chartSpeedText(5000)).toBe('1 div = 5k steps')
    expect(chartSpeedText(1)).toBe('1 div = 1 step')
    expect(chartSpeedText(2_000_000)).toBe('1 div = 2M steps')
  })
})

describe('markers', () => {
  test('lowerBound finds the first index at or above a value', () => {
    const xs = [1, 3, 3, 7]
    expect([0, 1, 2, 3, 4, 7, 8].map((v) => lowerBound(xs, v))).toEqual([0, 0, 1, 1, 3, 3, 4])
    expect(lowerBound(xs, 3, 2)).toBe(2)
  })

  test('markerColumns gives one entry per occupied pixel column', () => {
    const times = [0, 1, 2, 50, 51, 99, 150]
    expect(markerColumns(times, { start: 0, end: 100 }, 10)).toEqual([0, 5, 9])
  })

  test('property: markerColumns equals the distinct floored x of visible times', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(10_000), { maxLength: 400 }),
        fc.nat(9_000),
        fc.integer({ min: 50, max: 5000 }),
        fc.integer({ min: 1, max: 500 }),
        (raw, start, span, width) => {
          const times = [...raw].sort((a, b) => a - b)
          const view = { start, end: start + span }
          const want = [
            ...new Set(
              times
                .filter((t) => t >= view.start && t <= view.end)
                .map((t) => Math.floor(timeToX(t, view, width))),
            ),
          ]
          expect(markerColumns(times, view, width)).toEqual(want)
        },
      ),
    )
  })

  test('markerColumns on a million events stays fast', () => {
    const times = Float64Array.from({ length: 1_000_000 }, (_, i) => i * 2)
    const began = performance.now()
    const cols = markerColumns(times, { start: 0, end: 2_000_000 }, 1500)
    expect(cols.length).toBe(1500)
    expect(performance.now() - began).toBeLessThan(50)
  })

  test('mergeTimes sorts numerically', () => {
    expect(
      Array.from(
        mergeTimes([
          [10, 200],
          [3, 30],
        ]),
      ),
    ).toEqual([3, 10, 30, 200])
    expect(mergeTimes([]).length).toBe(0)
  })
})

describe('scale, progress and text', () => {
  test('depth 0 sits one unit above the baseline; deeper rises', () => {
    const scale = depthScale(4, 10, 110, 30)
    expect(scale.unit).toBe(20)
    expect(depthToY(0, scale)).toBe(90)
    expect(depthToY(4, scale)).toBe(10)
    expect(depthScale(0, 10, 110, 12).unit).toBe(12)
    expect(depthScale(1000, 10, 110, 12).unit).toBe(0.5)
  })

  test('approach eases toward the target and snaps', () => {
    const next = approach(0, 1, 100, 100)
    expect(next).toBeGreaterThan(0.6)
    expect(next).toBeLessThan(0.7)
    expect(approach(0.9999, 1, 16, 100)).toBe(1)
    expect(approach(0.5, 1, 0, 100)).toBe(0.5)
  })

  test('recordingFraction clamps', () => {
    expect(recordingFraction(50, 200)).toBe(0.25)
    expect(recordingFraction(500, 200)).toBe(1)
    expect(recordingFraction(5, 0)).toBe(0)
  })

  test('locationText and stepValueText', () => {
    expect(locationText(location())).toBe('line 7 · fib')
    expect(locationText(location({ source: 'prelude', functionName: 'map' }))).toBe('map (library)')
    expect(locationText(null)).toBe('end of run')
    expect(stepValueText(1234, 56789, location())).toBe('step 1,234 of 56,789, line 7')
    expect(stepValueText(5, 5, null)).toBe('step 5 of 5')
  })

  test('tapeWidth grows past seven digits', () => {
    expect(tapeWidth(56_789)).toBe(7)
    expect(tapeWidth(10_000_000)).toBe(8)
  })
})
