// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProvenanceEvent, StateView, ValueView, WriteTarget } from '../../core/index'
import { CallStack } from './CallStack'
import { Variables } from './Variables'
import {
  frameView,
  globalView,
  localView,
  renderWithRecording,
  stateView,
  viewRecording,
} from './test-fixtures'

afterEach(cleanup)

const num = (value: number): ValueView => ({ kind: 'number', value })

describe('CallStack', () => {
  const view = stateView({
    time: 3,
    frames: [
      frameView({ uid: 1, line: 12 }),
      frameView({ uid: 2, name: 'fib', line: 4, locals: [localView('n', 1, num(3), 2, 'param')] }),
      frameView({ uid: 3, name: 'map', line: 30, library: true }),
      frameView({ uid: 4, name: 'fib', line: 5, locals: [localView('n', 1, num(2), 4, 'param')] }),
    ],
  })
  const recording = viewRecording(10, (t) => ({ ...view, time: t }))

  test('lists user frames innermost first with their line and first locals', () => {
    renderWithRecording(<CallStack />, recording, 3)
    const rows = screen.getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual([
      'fibline 5n = 2',
      'fibline 4n = 3',
      '<top level>line 12',
    ])
    expect(rows[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/1 library frame hidden/)).toBeTruthy()
  })

  test('clicking a caller selects it; clicking the innermost frame clears the selection', () => {
    const { store } = renderWithRecording(<CallStack />, recording, 3)
    fireEvent.click(screen.getByRole('button', { name: /line 4/ }))
    expect(store.getState().selectedFrameUid).toBe(2)
    expect(screen.getByRole('button', { name: /line 4/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /line 5/ }))
    expect(store.getState().selectedFrameUid).toBeNull()
  })

  test('shows library frames, dimmed, when just-my-code is off', () => {
    const { store } = renderWithRecording(<CallStack />, recording, 3)
    act(() => store.getState().updateSettings({ justMyCode: false }))
    const library = screen.getByRole('button', { name: /map/ })
    expect(library.className).toContain('pn-frame--library')
    expect(library.textContent).toContain('library · line 30')
  })

  test('says the program finished at the end of a finished run', () => {
    const finished = viewRecording(1234, (t) => stateView({ time: t }))
    renderWithRecording(<CallStack />, finished, 1234)
    expect(screen.getByText('Program finished')).toBeTruthy()
    expect(screen.getByText('1,234 steps')).toBeTruthy()
  })

  test('shows the recorded stack for an error when the view has no frames', () => {
    const failed = viewRecording(5, (t) => stateView({ time: t }), {
      outcome: {
        kind: 'error',
        error: {
          code: 'R010',
          message: "record has no field 'y'",
          span: { start: 0, end: 1 },
          stack: [{ name: 'lookup', span: { start: 0, end: 1 }, library: false }],
          time: 5,
        },
      },
    })
    renderWithRecording(<CallStack />, failed, 5)
    expect(screen.getByText(/record has no field/)).toBeTruthy()
    expect(screen.getByText('lookup')).toBeTruthy()
  })

  test('asks for a run when there is no recording', () => {
    renderWithRecording(<CallStack />, null)
    expect(screen.getByText('Run the program to see its call stack')).toBeTruthy()
  })
})

describe('Variables', () => {
  const xs: readonly number[] = [1, 2, 2, 2, 9]
  const views: StateView[] = Array.from({ length: 1001 }, (_, t) =>
    stateView({
      time: t,
      frames: [
        frameView({
          uid: 1,
          locals: [localView('x', 1, num(xs[Math.min(t, 4)]! + (t >= 900 ? 100 : 0)), 1, 'var')],
          captures: [{ name: 'c', value: num(7), target: { kind: 'cell', cellId: 3 } }],
        }),
      ],
      globals: [globalView('g', { kind: 'string', value: 'hi' }, 'let')],
    }),
  )
  const origin: ProvenanceEvent = {
    time: 1,
    kind: 'write',
    target: { kind: 'local', frameUid: 1, slot: 1 },
    value: 2,
  }
  const history = vi.fn((target: WriteTarget) => ({
    events: [
      { ...origin, target, time: 0, kind: 'declare' as const, value: 1 },
      { ...origin, target, time: 1, value: 2 },
      { ...origin, target, time: 3, value: 9 },
    ],
    total: 1200,
    truncated: true,
  }))
  const recording = viewRecording(1000, (t) => views[t]!, { origin: () => origin, history })

  test('groups locals, captured variables and globals with kind badges', () => {
    renderWithRecording(<Variables />, recording, 0)
    expect(screen.getByRole('heading', { name: 'Locals · <top level>' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Captured' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Globals' })).toBeTruthy()
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent)
    expect(rows).toEqual(['xvar1⟲history', 'ccap7⟲history', 'glet"hi"⟲history'])
  })

  test('jump to origin moves the pen to the write that set the value', () => {
    const { store } = renderWithRecording(<Variables />, recording, 4)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to where x was set' }))
    expect(store.getState().time).toBe(1)
    expect(store.getState().notice?.text).toBe('x was set here (step 1)')
  })

  test('history watches the binding, lists its changes and closes again', () => {
    const { store } = renderWithRecording(<Variables />, recording, 2)
    fireEvent.click(screen.getByRole('button', { name: 'Show the history of x' }))
    expect(store.getState().watch).toEqual({ target: origin.target, label: 'x', at: 2 })
    expect(history).toHaveBeenCalledWith(origin.target, 2, { limit: 500 })
    const region = screen.getByRole('region', { name: 'History of x' })
    expect(region.textContent).toContain('1,200 changes')
    expect(region.textContent).toContain('Showing 3 of 1,200, evenly sampled')
    expect(screen.getByRole('img', { name: 'Values over 3 changes, from 1 to 9' })).toBeTruthy()
    const current = region.querySelector('[aria-current="step"]')
    expect(current?.textContent).toBe('1set2')
    fireEvent.click(screen.getByRole('button', { name: '3set9' }))
    expect(store.getState().time).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: 'Close history' }))
    expect(store.getState().watch).toBeNull()
    expect(screen.queryByRole('region', { name: 'History of x' })).toBeNull()
  })

  test('rows flash when their value changed since the previous pen position', () => {
    const { store } = renderWithRecording(<Variables />, recording, 0)
    const changed = () =>
      [...document.querySelectorAll('[data-changed]')].map((row) => row.textContent)
    expect(changed()).toEqual([])
    act(() => store.getState().seek(1))
    expect(changed()).toEqual(['xvar2⟲history'])
    act(() => store.getState().seek(2))
    expect(changed()).toEqual([])
    act(() => store.getState().seek(950))
    expect(changed()).toEqual([])
  })

  test('shows an empty state when nothing is live', () => {
    const empty = viewRecording(3, (t) => stateView({ time: t }))
    renderWithRecording(<Variables />, empty, 3)
    expect(screen.getByText('No variables yet: step forward')).toBeTruthy()
  })
})
