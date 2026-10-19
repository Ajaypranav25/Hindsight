// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ObjectView, Recording, ValueView, WriteTarget } from '../../core/index'
import { compile, record } from '../../core/index'
import { EXAMPLES } from '../examples'
import { CallStack } from './CallStack'
import { Console } from './Console'
import { renderWithRecording, stateView, viewRecording } from './test-fixtures'
import { ValueRow } from './ValueTree'
import { Variables } from './Variables'

afterEach(cleanup)

const num = (value: number): ValueView => ({ kind: 'number', value })
const ref = (
  id: number,
  type: 'list' | 'record' | 'function' | 'range' | 'builtin',
  preview: string,
): ValueView => ({
  kind: 'ref',
  id,
  type,
  preview,
})

describe('ValueTree', () => {
  const LONG = 250
  const longList = (offset: number, limit: number): ObjectView => ({
    type: 'list',
    id: 5,
    offset,
    items: Array.from({ length: Math.max(0, Math.min(limit, LONG - offset)) }, (_, i) =>
      num((offset + i) * 10),
    ),
    length: LONG,
  })
  const heap = new Map<number, ObjectView>([
    [5, longList(0, 100)],
    [
      6,
      {
        type: 'record',
        id: 6,
        offset: 0,
        entries: [
          { key: 'self', value: ref(6, 'record', '{self: {...}}') },
          { key: 'my key', value: num(1) },
        ],
        length: 2,
      },
    ],
    [8, { type: 'range', id: 8, start: 0, end: 10, step: 2, inclusive: true }],
    [9, { type: 'builtin', id: 9, name: 'map' }],
  ])
  const objectAt = vi.fn((_t: number, id: number, range?: { offset: number; limit: number }) =>
    id === 5 ? longList(range?.offset ?? 0, range?.limit ?? 100) : null,
  )
  const origin = vi.fn((_target: WriteTarget) => null)
  const recording = viewRecording(10, (t) => stateView({ time: t, heap }), { objectAt, origin })

  function renderRow(value: ValueView, name: string) {
    return renderWithRecording(
      <ul>
        <ValueRow name={name} value={value} label={name} target={{ kind: 'global', name }} />
      </ul>,
      recording,
      4,
    )
  }

  test('expands a long list 100 items at a time', () => {
    renderRow(ref(5, 'list', '[0, 10, 20, …]'), 'xs')
    fireEvent.click(screen.getByRole('button', { name: 'Expand xs' }))
    expect(screen.getByText('[99]')).toBeTruthy()
    expect(screen.queryByText('[100]')).toBeNull()
    expect(objectAt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Show 100 more (of 250)' }))
    expect(objectAt).toHaveBeenLastCalledWith(4, 5, { offset: 0, limit: 200 })
    expect(screen.getByText('[199]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more (of 250)' }))
    expect(screen.getByText('[249]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show .* more/ })).toBeNull()
  })

  test('element rows jump to the origin of that element', () => {
    renderRow(ref(5, 'list', '[0, 10, 20, …]'), 'xs')
    fireEvent.click(screen.getByRole('button', { name: 'Expand xs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Jump to where xs[3] was set' }))
    expect(origin).toHaveBeenLastCalledWith({ kind: 'element', objectId: 5, index: 3 }, 4)
  })

  test('record rows use field targets and cycles are cut', () => {
    renderRow(ref(6, 'record', '{self: {...}}'), 'r')
    fireEvent.click(screen.getByRole('button', { name: 'Expand r' }))
    expect(screen.queryByRole('button', { name: 'Expand r.self' })).toBeNull()
    expect(screen.getByTitle('This object contains itself')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Jump to where r["my key"] was set' }))
    expect(origin).toHaveBeenLastCalledWith({ kind: 'field', objectId: 6, key: 'my key' }, 4)
  })

  test('ranges show their bounds and builtins their name', () => {
    renderRow(ref(8, 'range', '0..=10'), 'r')
    expect(screen.getByText('0..=10 by 2')).toBeTruthy()
    cleanup()
    renderRow(ref(9, 'builtin', '<builtin map>'), 'f')
    expect(screen.getByText('builtin map')).toBeTruthy()
  })

  test('says when an object is not reachable', () => {
    renderRow(ref(77, 'list', '[1]'), 'gone')
    fireEvent.click(screen.getByRole('button', { name: 'Expand gone' }))
    expect(screen.getByText('Not reachable at this step')).toBeTruthy()
  })
})

describe('Console', () => {
  const outputs = [
    { time: 2, text: 'first' },
    { time: 5, text: 'two\nlines' },
    { time: 8, text: 'last' },
  ]
  const recording = viewRecording(10, (t) => stateView({ time: t }), {
    outputs,
    outcome: {
      kind: 'error',
      error: {
        code: 'R001',
        message: 'division by zero',
        hint: 'Check the divisor',
        span: { start: 0, end: 1 },
        stack: [],
        time: 10,
      },
    },
  })

  test('ghosts future output and marks the line printed at the pen', () => {
    renderWithRecording(<Console />, recording, 5)
    const lines = screen.getAllByRole('listitem')
    expect(lines.map((line) => line.className)).toEqual([
      'pn-line',
      'pn-line pn-line--future pn-line--now',
      'pn-line pn-line--future',
    ])
    expect(lines[1]!.querySelector('.pn-out')?.textContent).toBe('two\nlines')
    expect(lines[1]!.querySelector('[aria-current="step"]')).toBeTruthy()
  })

  test('clicking a line moves the pen to when it was printed', () => {
    const { store } = renderWithRecording(<Console />, recording, 5)
    fireEvent.click(screen.getByRole('button', { name: /last/ }))
    expect(store.getState().time).toBe(8)
  })

  test('shows the runtime error with a jump to the failure', () => {
    const { store } = renderWithRecording(<Console />, recording, 3)
    expect(screen.getByRole('group', { name: 'Runtime error' }).textContent).toContain(
      'Check the divisor',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Jump to the failure' }))
    expect(store.getState().time).toBe(10)
    expect(screen.queryByRole('button', { name: 'Jump to the failure' })).toBeNull()
  })

  test('lists compile errors with their lines', () => {
    const { store } = renderWithRecording(<Console />, null)
    act(() =>
      store.setState({
        source: 'let a = 1\nprint(b)\n',
        compile: {
          ok: false,
          diagnostics: [
            {
              code: 'E020',
              severity: 'error',
              message: "undefined variable 'b'",
              hint: 'Declare it first',
              span: { start: 16, end: 17 },
            },
          ],
        },
      }),
    )
    const section = screen.getByRole('region', { name: 'Does not compile' })
    expect(section.textContent).toContain('line 2')
    expect(section.textContent).toContain("undefined variable 'b'")
  })
})

describe('panels on real recordings', () => {
  test('render every example at sampled times without failing', () => {
    for (const example of EXAMPLES) {
      const compiled = compile(example.source)
      if (!compiled.ok) throw new Error(`${example.id} does not compile`)
      const recording: Recording = record(compiled.program, { maxSteps: 20_000 })
      const { store, unmount } = renderWithRecording(
        <>
          <CallStack />
          <Variables />
          <Console />
        </>,
        recording,
        0,
      )
      const samples = 8
      for (let i = 0; i <= samples; i++) {
        act(() => store.getState().seek(Math.round((recording.length * i) / samples)))
        for (const button of screen.queryAllByRole('button', { name: /^Expand / }).slice(0, 3))
          fireEvent.click(button)
      }
      act(() => store.getState().updateSettings({ justMyCode: false }))
      act(() => store.getState().seek(Math.floor(recording.length / 2)))
      expect(document.body.textContent).not.toBe('')
      unmount()
    }
  })
})
