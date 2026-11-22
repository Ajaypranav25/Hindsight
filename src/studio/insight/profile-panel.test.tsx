// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { setAnalysisService } from '../analysis/service'
import { renderWithRecording } from '../panels/test-fixtures'
import { FLAME_ROW_PX, ProfilePanel } from './ProfilePanel'

const FIB =
  'fn fib(n) {\n  if n < 2 { return n }\n  fib(n - 1) + fib(n - 2)\n}\n' +
  'fn main() {\n  print(fib(8))\n}\nmain()\n'

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

/** A ResizeObserver that reports one fixed size as soon as it observes. */
class FixedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    const entry = { contentRect: { width: 400, height: 200 } } as ResizeObserverEntry
    this.callback([entry], this as unknown as ResizeObserver)
  }
  disconnect(): void {}
  unobserve(): void {}
}

function fakeContext(): CanvasRenderingContext2D {
  return {
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => {},
    fillText: () => {},
    measureText: () => ({ width: 6 }),
  } as unknown as CanvasRenderingContext2D
}

beforeEach(() => setAnalysisService(null))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setAnalysisService(null)
})

describe('the Profile panel', () => {
  test('asks for a run first', () => {
    renderWithRecording(<ProfilePanel />, null)

    expect(screen.getByText('Run the program to profile it')).toBeTruthy()
  })

  test('profiles the shown run and lists its functions in the table', async () => {
    const recording = recordSource(FIB)
    const { store } = renderWithRecording(<ProfilePanel />, recording)
    expect(screen.getByText('Profiling…')).toBeTruthy()

    await screen.findByText(/steps · \d+ functions · just my code/)
    fireEvent.click(screen.getByRole('button', { name: 'Table' }))

    expect(screen.getByRole('table', { name: 'Functions by inclusive steps' })).toBeTruthy()
    expect(screen.getByRole('table', { name: 'Busiest lines' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'fib' }))
    const fibEntry = store.getState().time
    expect(recording.locationAt(fibEntry)!.functionName).toBe('fib')
    fireEvent.click(screen.getByRole('button', { name: 'Flame chart' }))
    expect(screen.getByRole('img', { name: /Flame chart of/ })).toBeTruthy()
  })

  test('says when the profile could not be computed', async () => {
    setAnalysisService({
      analyze: () => Promise.reject(new Error('no worker today')),
    })
    renderWithRecording(<ProfilePanel />, recordSource(FIB))

    expect(await screen.findByText(/could not be computed: no worker today/)).toBeTruthy()
  })

  test('hovering a box names it, and clicking it moves the pen to its first call', async () => {
    vi.stubGlobal('ResizeObserver', FixedResizeObserver)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => fakeContext() as never,
    )
    const recording = recordSource(FIB)
    const { store } = renderWithRecording(<ProfilePanel />, recording)
    const chart = await screen.findByRole('img', { name: /Flame chart of/ })
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      width: 400,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    // Row 1 holds main, which spans nearly the whole width.
    act(() => {
      fireEvent.pointerMove(chart, { clientX: 100, clientY: FLAME_ROW_PX + 4 })
    })
    const tip = screen.getByRole('status')
    expect(tip.textContent).toContain('main')
    expect(tip.textContent).toContain('1 call')
    fireEvent.click(chart, { clientX: 100, clientY: FLAME_ROW_PX + 4 })
    expect(recording.locationAt(store.getState().time)!.functionName).toBe('main')
    act(() => {
      fireEvent.pointerLeave(chart)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
