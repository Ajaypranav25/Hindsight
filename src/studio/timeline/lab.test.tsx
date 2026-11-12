// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { compile, queryRecording, record, type Recording } from '../../core/index'
import { buildEnvelope, fullViewport } from '../lib/timeline-math'
import { renderWithRecording } from '../panels/test-fixtures'
import { liveQuery, liveSweep } from '../state/lab'
import { drawQueryMarks, drawSweepGhosts, labMaxDepth, type ChartLab } from './chart-lab'
import { neighbours, QueryBar, queryRows, querySummary } from './QueryBar'
import { longestRun, SweepBanner, sweepHeadline } from './SweepBanner'

afterEach(cleanup)

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

const FIB =
  'fn fib(n) { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } }\nvar best = 0\nbest = fib(6)\nprint(best)\n'

const COLLATZ =
  'fn steps(n) {\n  var count = 0\n  var x = n\n  while x != 1 {\n' +
  '    x = if x % 2 == 0 { x / 2 } else { 3 * x + 1 }\n    count += 1\n  }\n  count\n}\n' +
  'let start = 6\nprint(steps(start))\n'

function result(recording: Recording, text: string) {
  const outcome = queryRecording(recording, text)
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome.result
}

describe('query texts', () => {
  test('summaries name what was found', () => {
    const recording = recordSource(FIB)
    expect(querySummary(result(recording, 'calls(fib)'))).toBe('25 calls')
    expect(querySummary(result(recording, 'calls(fib) where ret > 99'))).toBe('no call matches')
    expect(querySummary(result(recording, 'changed(best)'))).toBe('2 changes')
    expect(querySummary(result(recording, 'when depth == 1'))).toMatch(
      /^1 stretch · \d+ statements$/,
    )
    expect(querySummary(result(recording, 'when depth > 99'))).toBe('never true')
  })

  test('rows say when, where and what', () => {
    const recording = recordSource(FIB)
    const calls = queryRows(recording, result(recording, 'calls(fib) where n == 6'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).toMatch(/^step \d+ · fib\(n = 6\) returned 8$/)
    const changes = queryRows(recording, result(recording, 'changed(best)'))
    expect(changes.map((row) => row.text.replace(/^step \d+ · /, ''))).toEqual([
      'line 2 · best = 0',
      'line 3 · best = 8',
    ])
    const stretches = queryRows(recording, result(recording, 'when depth == 1'))
    expect(stretches[0]!.text).toMatch(/^step \d+ to \d+ · line 1$/)
  })

  test('neighbours are the nearest matches on either side of the pen', () => {
    expect(neighbours([2, 5, 9], 5)).toEqual({ previous: 2, next: 9 })
    expect(neighbours([2, 5, 9], 1)).toEqual({ previous: null, next: 2 })
    expect(neighbours([2, 5, 9], 10)).toEqual({ previous: 9, next: null })
    expect(neighbours([], 3)).toEqual({ previous: null, next: null })
  })
})

describe('QueryBar', () => {
  function type(text: string) {
    const input = screen.getByRole('textbox', { name: 'Query' })
    fireEvent.change(input, { target: { value: text } })
    fireEvent.submit(input.closest('form')!)
    return input
  }

  test('runs a query, marks the matches and steps through them', async () => {
    const recording = recordSource(FIB)
    const { store } = renderWithRecording(<QueryBar />, recording, 0)
    type('calls(fib) where n >= 5')
    expect(screen.getByText('Searching…')).toBeTruthy()
    await screen.findByText('2 calls')
    const marks = liveQuery(store.getState().lab, recording)
    expect(marks?.text).toBe('calls(fib) where n >= 5')
    const [first, second] = marks!.result.kind === 'calls' ? marks!.result.calls : []
    const previous = screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement
    const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement
    expect(previous.disabled).toBe(true)
    fireEvent.click(next)
    expect(store.getState().time).toBe(first!.entry)
    fireEvent.click(next)
    expect(store.getState().time).toBe(second!.entry)
    expect(next.disabled).toBe(true)
    fireEvent.click(previous)
    expect(store.getState().time).toBe(first!.entry)
  })

  test('the list jumps to a match; Escape clears the query', async () => {
    const recording = recordSource(FIB)
    const { store } = renderWithRecording(<QueryBar />, recording, 0)
    const input = type('changed(best)')
    await screen.findByText('2 changes')
    const toggle = screen.getByRole('button', { name: 'List' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const rows = screen.getByRole('list', { name: 'Query matches' }).querySelectorAll('button')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1]!)
    expect(
      recording.stateAt(store.getState().time).globals.find((g) => g.name === 'best'),
    ).toMatchObject({ value: { kind: 'number', value: 8 } })
    expect(rows[1]!.getAttribute('aria-current')).toBe('step')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(liveQuery(store.getState().lab, recording)).toBeNull()
    expect((input as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  })

  test('a query that does not parse says why and marks nothing', async () => {
    const recording = recordSource(FIB)
    const { store } = renderWithRecording(<QueryBar />, recording, 0)
    const input = type('when print(1)')
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Queries can call only'),
    )
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(liveQuery(store.getState().lab, recording)).toBeNull()
    type('calls(nope)')
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('No function named nope'),
    )
  })

  test('marks belong to their recording; without one the field is disabled', async () => {
    const recording = recordSource(FIB)
    const { store } = renderWithRecording(<QueryBar />, recording, 0)
    type('when depth > 2')
    await screen.findByText(/stretch/)
    act(() => store.setState({ recording: recordSource('print(1)\n') }))
    expect(screen.queryByText(/stretch/)).toBeNull()
    cleanup()
    renderWithRecording(<QueryBar />, null)
    expect((screen.getByRole('textbox', { name: 'Query' }) as HTMLInputElement).disabled).toBe(true)
  })
})

describe('sweeps', () => {
  async function swept() {
    const recording = recordSource(COLLATZ)
    const at = recording.lineHits(11)[0]!
    const start = recording.stateAt(at).globals.find((global) => global.name === 'start')!
    const rendered = renderWithRecording(<SweepBanner />, recording, at)
    await act(() =>
      rendered.store.getState().sweepWhatIf(start.target, [6, 7, 27], 'start', '6, 7, 27'),
    )
    return { recording, at, ...rendered }
  }

  test('forks once per value and shows the runs with the longest marked', async () => {
    const { store, recording, at } = await swept()
    const sweep = liveSweep(store.getState().lab, recording)!
    expect(sweep).toMatchObject({ running: false, done: 3, total: 3, label: 'start = 6, 7, 27' })
    expect(sweepHeadline(sweep)).toBe(`start = 6, 7, 27 at step ${at} · 3 runs`)
    expect(longestRun(sweep.runs)).toBe(2)
    const rows = screen.getByRole('table').querySelectorAll('tbody tr')
    expect(rows).toHaveLength(3)
    expect(rows[2]!.textContent).toContain('longest')
    expect(rows[0]!.textContent).toContain('same output')
    expect(rows[2]!.textContent).toContain('1 changed')
    expect(screen.getByText('Sweep finished: ' + sweepHeadline(sweep))).toBeTruthy()
  })

  test('a row opens that run as a what-if, and the sweep is back after leaving it', async () => {
    const { store, recording, at } = await swept()
    fireEvent.click(screen.getByRole('button', { name: '27' }))
    const state = store.getState()
    expect(state.whatIf).toMatchObject({ parent: recording, label: `start = 27 at step ${at}` })
    expect(state.recording?.outputs[0]?.text).toBe('111')
    expect(state.time).toBe(at)
    expect(screen.queryByRole('group', { name: 'Sweep' })).toBeNull()
    act(() => store.getState().leaveWhatIf())
    expect(screen.getByRole('group', { name: 'Sweep' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close sweep' }))
    expect(store.getState().lab.sweep).toBeNull()
  })

  test('a sweep needs a future to replay, and reports values it cannot write', async () => {
    const recording = recordSource(COLLATZ)
    const { store } = renderWithRecording(<SweepBanner />, recording, recording.length)
    const target = { kind: 'global', name: 'start' } as const
    await act(() => store.getState().sweepWhatIf(target, [1, 2], 'start', '1..2'))
    expect(store.getState().lab.sweep).toBeNull()
    expect(store.getState().notice?.text).toContain('move the pen back')
    act(() => store.setState({ time: 0 }))
    await act(() => store.getState().sweepWhatIf(target, [1], 'start', '1'))
    expect(liveSweep(store.getState().lab, recording)?.failed).toHaveLength(1)
    expect(screen.getByRole('table').textContent).toContain('1')
  })

  test('a sweep stops when another run is shown', async () => {
    const recording = recordSource(COLLATZ)
    const at = recording.lineHits(11)[0]!
    const start = recording.stateAt(at).globals.find((global) => global.name === 'start')!
    const { store } = renderWithRecording(<SweepBanner />, recording, at)
    let running: Promise<void> = Promise.resolve()
    act(() => {
      running = store.getState().sweepWhatIf(start.target, [6, 7, 27], 'start', '6, 7, 27')
      store.setState({ recording: recordSource('print(1)\n') })
    })
    await act(() => running)
    expect(store.getState().lab.sweep).toBeNull()
  })
})

describe('chart layers', () => {
  function fakeContext() {
    const calls: string[] = []
    const ctx = {
      globalAlpha: 1,
      fillStyle: '',
      fillRect: (x: number, y: number, w: number, h: number) =>
        calls.push(`rect ${x} ${y} ${w} ${h}`),
      beginPath: () => calls.push('begin'),
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      rect: () => calls.push('trace'),
      fill: () => calls.push('fill'),
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
  }
  const layout = {
    view: fullViewport(100),
    w: 200,
    px: 1,
    top: 10,
    scale: { baseline: 60, unit: 5 } as never,
  }

  test('stretches become bands and moments become hairlines inside the view', () => {
    const lab: ChartLab = {
      intervals: [
        { from: 10, to: 20 },
        { from: 500, to: 600 },
      ],
      moments: [50, 50, 700],
      ghosts: [],
      forkTime: 0,
    }
    const { ctx, calls } = fakeContext()
    drawQueryMarks(ctx, lab, layout, 'blue')
    expect(calls.filter((call) => call.startsWith('rect'))).toEqual([
      'rect 20 10 20 50',
      'rect 100 10 1 50',
    ])
    expect(ctx.globalAlpha).toBe(1)
  })

  test('every sweep run is traced from the fork step on', () => {
    const depths = Int32Array.from({ length: 100 }, (_, i) => (i > 50 ? 2 : 0))
    const lab: ChartLab = {
      intervals: [],
      moments: [],
      ghosts: [buildEnvelope(depths), buildEnvelope(depths)],
      forkTime: 40,
    }
    expect(labMaxDepth(lab)).toBe(2)
    expect(labMaxDepth(null)).toBe(0)
    const { ctx, calls } = fakeContext()
    drawSweepGhosts(ctx, lab, layout, 'purple')
    expect(calls.filter((call) => call === 'fill')).toHaveLength(2)
    expect(calls.filter((call) => call === 'trace').length).toBeGreaterThan(100)
    expect(ctx.globalAlpha).toBe(1)
  })
})
