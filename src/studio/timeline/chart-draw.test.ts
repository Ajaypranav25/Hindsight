import { describe, expect, test } from 'vitest'
import { compile, record } from '../../core/index'
import { buildEnvelope, fullViewport, mergeTimes } from '../lib/timeline-math'
import { drawChart, type ChartColors, type ChartScene } from './chart-draw'

/** A 2D context stand-in that records the calls and style values it receives. */
function fakeContext() {
  const calls: string[] = []
  const styles: unknown[] = []
  const target: Record<string, unknown> = { measureText: () => ({ width: 20 }) }
  const ctx = new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key as string]
      return (...args: unknown[]) => {
        calls.push(String(key))
        return args.length
      }
    },
    set(obj, key, value) {
      obj[key as string] = value
      styles.push(value)
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, styles }
}

const colors: ChartColors = {
  gridMinor: 'g1',
  gridMajor: 'g2',
  traceFill: 'tf',
  traceLine: 'tl',
  pen: 'pen',
  penSoft: 'pen-soft',
  marker: 'marker',
  error: 'error',
  inkMuted: 'ink-muted',
  surface: 'surface',
  rule: 'rule',
  fontMono: 'mono',
}

function scene(): ChartScene {
  const result = compile(
    'fn fib(n) {\n  if n < 2 {\n    return n\n  }\n  fib(n - 1) + fib(n - 2)\n}\nprint(fib(8))\nprint(1 / 0)\n',
  )
  if (!result.ok) throw new Error('compile failed')
  const recording = record(result.program)
  return {
    width: 600,
    height: 120,
    dpr: 2,
    view: fullViewport(recording.length),
    length: recording.length,
    env: buildEnvelope(recording.depthSeries()),
    time: Math.floor(recording.length / 2),
    penDepth: recording.depthAt(Math.floor(recording.length / 2)),
    outputTimes: Float64Array.from(recording.outputs, (o) => o.time),
    breakpointTimes: mergeTimes([recording.lineHits(3)]),
    watchTimes: [1, 5, 9],
    errorAt: recording.outcome.kind === 'error' ? recording.length : null,
    stale: false,
    progress: null,
    colors,
  }
}

describe('drawChart', () => {
  test('draws grid, trace, markers, error flag and pen from a real recording', () => {
    const { ctx, calls, styles } = fakeContext()
    const s = scene()
    expect(s.errorAt).not.toBeNull()
    drawChart(ctx, s)
    expect(calls).toContain('clearRect')
    expect(calls.filter((c) => c === 'rect').length).toBeGreaterThan(1000)
    for (const color of ['g1', 'g2', 'tf', 'tl', 'pen', 'marker', 'error', 'ink-muted']) {
      expect(styles).toContain(color)
    }
    expect(calls).toContain('fillText')
  })

  test('draws the recording progress instead of the pen while recording, dimmed when stale', () => {
    const { ctx, styles } = fakeContext()
    drawChart(ctx, { ...scene(), progress: 0.4, stale: true })
    expect(styles).toContain('pen-soft')
    expect(styles).toContain(0.4)
  })

  test('draws an empty grid without a recording', () => {
    const { ctx, calls } = fakeContext()
    drawChart(ctx, {
      ...scene(),
      env: null,
      length: 0,
      view: fullViewport(0),
      outputTimes: [],
      breakpointTimes: [],
      watchTimes: [],
      errorAt: null,
    })
    expect(calls).not.toContain('arc')
    expect(calls).toContain('fillRect')
  })
})
