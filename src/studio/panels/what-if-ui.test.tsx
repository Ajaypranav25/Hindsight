// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ForkResult, Recording, WriteTarget } from '../../core/index'
import { Console } from './Console'
import { Variables } from './Variables'
import {
  frameView,
  globalView,
  renderWithRecording,
  stateView,
  viewRecording,
} from './test-fixtures'
import { fakeRecording } from '../state/testing'
import { StripChart } from '../timeline/StripChart'
import { literalText } from './WhatIfEdit'

afterEach(cleanup)

const TOTAL: WriteTarget = { kind: 'global', name: 'total' }

function totals(forkAsync: Recording['forkAsync']): Recording {
  const view = stateView({
    time: 3,
    frames: [frameView({ uid: 1 })],
    globals: [
      globalView('total', { kind: 'number', value: 6 }, 'var'),
      globalView('xs', { kind: 'ref', id: 9, type: 'list', preview: '[1]' }),
    ],
  })
  return viewRecording(10, () => view, { forkAsync })
}

const NOT_YET: ForkResult = { ok: false, error: { code: 'time', message: 'not yet' } }

describe('what-if editing in the Variables panel', () => {
  test('primitive values offer a what-if; objects do not', () => {
    renderWithRecording(<Variables />, totals(vi.fn()), 3)
    expect(
      screen.getByRole('button', { name: 'What if total were different at step 3?' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /What if xs were/ })).toBeNull()
  })

  test('the button opens an editor prefilled with the literal; Enter forks at the pen', async () => {
    const forkAsync = vi.fn(async () => NOT_YET)
    renderWithRecording(<Variables />, totals(forkAsync), 3)
    fireEvent.click(screen.getByRole('button', { name: /What if total were different/ }))
    const input = screen.getByRole('textbox', { name: /What if total were/ }) as HTMLInputElement
    expect(input.value).toBe('6')
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'oops' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText(/oops is a name, not a value/)).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(forkAsync).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '-2.5' } })
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect(forkAsync).toHaveBeenCalledWith(
      3,
      { target: TOTAL, value: -2.5 },
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  test('double-clicking a value edits it; Escape cancels', () => {
    const forkAsync = vi.fn(async () => NOT_YET)
    renderWithRecording(<Variables />, totals(forkAsync), 3)
    fireEvent.doubleClick(screen.getByText('6'))
    const input = screen.getByRole('textbox', { name: /What if total were/ })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(forkAsync).not.toHaveBeenCalled()
  })

  test('Escape and Enter return focus to the what-if button', async () => {
    const forkAsync = vi.fn(() => new Promise<ForkResult>(() => {}))
    renderWithRecording(<Variables />, totals(forkAsync), 3)
    const whatIf = () => screen.getByRole('button', { name: /What if total were different/ })
    fireEvent.click(whatIf())
    fireEvent.keyDown(screen.getByRole('textbox', { name: /What if total were/ }), {
      key: 'Escape',
    })
    expect(document.activeElement).toBe(whatIf())
    fireEvent.click(whatIf())
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('textbox', { name: /What if total were/ }), {
        key: 'Enter',
      }),
    )
    // While the fork records, the button stays (disabled) so focus has somewhere to wait.
    expect(document.activeElement).toBe(whatIf())
    expect(whatIf().getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(whatIf())
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  test('leaving the editor by clicking elsewhere does not pull focus back', () => {
    renderWithRecording(
      <>
        <Variables />
        <button type="button">elsewhere</button>
      </>,
      totals(vi.fn()),
      3,
    )
    fireEvent.click(screen.getByRole('button', { name: /What if total were different/ }))
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' })
    act(() => elsewhere.focus())
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  test('once the fork is shown, focus moves from the what-if button to the banner', async () => {
    let finish: (result: ForkResult) => void = () => {}
    const forkAsync = vi.fn(() => new Promise<ForkResult>((resolve) => (finish = resolve)))
    renderWithRecording(
      <>
        <StripChart />
        <Variables />
      </>,
      totals(forkAsync),
      3,
    )
    fireEvent.click(screen.getByRole('button', { name: /What if total were different/ }))
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('textbox', { name: /What if total were/ }), {
        key: 'Enter',
      }),
    )
    await act(async () => finish({ ok: true, recording: totals(vi.fn()) }))
    const banner = screen.getByRole('group', { name: 'What if' })
    expect(banner.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.textContent).toMatch(/^What if total = 6 at step 3 · /)
  })

  test('no what-if at the end of the run', () => {
    renderWithRecording(<Variables />, totals(vi.fn()), 10)
    expect(screen.queryByRole('button', { name: /What if total/ })).toBeNull()
  })

  test('literals for every primitive kind', () => {
    expect(literalText({ kind: 'nil' })).toBe('nil')
    expect(literalText({ kind: 'bool', value: false })).toBe('false')
    expect(literalText({ kind: 'string', value: 'a{b}' })).toBe('"a\\{b\\}"')
    expect(literalText({ kind: 'ref', id: 1, type: 'list', preview: '[]' })).toBe('')
  })
})

function whatIfStore() {
  const parent = fakeRecording({ length: 50, outputs: [{ time: 5, text: 'old' }] })
  const fork = fakeRecording({
    length: 60,
    outputs: [
      { time: 5, text: 'new' },
      { time: 9, text: 'extra' },
    ],
  })
  const { store } = renderWithRecording(
    <>
      <StripChart />
      <Console />
    </>,
    parent,
    20,
  )
  act(() =>
    store.setState({
      recording: fork,
      time: 20,
      whatIf: {
        parent,
        parentTime: 20,
        edits: [{ time: 20, text: 'total = 0' }],
        label: 'total = 0 at step 20',
        comparison: {
          divergence: 25,
          lines: [
            { kind: 'removed', text: 'old', indexA: 0, indexB: null, timeA: 5, timeB: null },
            { kind: 'added', text: 'new', indexA: null, indexB: 0, timeA: null, timeB: 5 },
            { kind: 'added', text: 'extra', indexA: null, indexB: 1, timeA: null, timeB: 9 },
          ],
          removed: 1,
          added: 2,
        },
      },
    }),
  )
  return { store, parent, fork }
}

describe('the what-if banner and console', () => {
  test('the banner says what changed and goes to the divergence or back', () => {
    const { store, parent } = whatIfStore()
    const banner = screen.getByRole('group', { name: 'What if' })
    expect(banner.textContent).toContain('What if total = 0 at step 20')
    expect(banner.textContent).toContain('diverges at step 25 · 2 of 2 output lines changed')
    expect(screen.getByText(/What if total = 0 at step 20 · diverges/).tagName).toBe('P')
    fireEvent.click(screen.getByRole('button', { name: 'Go to divergence' }))
    expect(store.getState().time).toBe(25)
    fireEvent.click(screen.getByRole('button', { name: 'Back to the real run' }))
    expect(store.getState().recording).toBe(parent)
    expect(store.getState().whatIf).toBeNull()
    expect(screen.queryByRole('group', { name: 'What if' })).toBeNull()
    // The banner went away with its button, so focus lands on the timeline.
    expect(document.activeElement).toBe(screen.getByRole('slider', { name: 'Time' }))
  })

  test('the console marks the lines the real run did not print', () => {
    whatIfStore()
    const lines = screen.getAllByRole('button', { name: /new|extra/ })
    expect(lines.map((line) => line.textContent)).toEqual(['5newchanged', '9extrachanged'])
    expect(screen.getByText(/1 line of the real run is not printed/)).toBeTruthy()
  })
})

test('the banner renders nothing visible outside what-if mode', () => {
  render(<p>placeholder</p>)
  renderWithRecording(<StripChart />, fakeRecording({ length: 5 }), 0)
  expect(screen.queryByRole('group', { name: 'What if' })).toBeNull()
})
