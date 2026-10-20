// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { ObjectView, Recording, StateView, ValueView } from '../../core/api-types'
import { memoryStorage } from '../lib/storage'
import { StudioProvider } from '../state/context'
import { ManualScheduler } from '../state/scheduler'
import { createStudioStore } from '../state/store'
import { fakeRecording, scriptedEngine } from '../state/testing'
import { HeapGraph } from './HeapGraph'

const span = { start: 0, end: 1 }
const num = (value: number): ValueView => ({ kind: 'number', value })
const ref = (id: number, type: 'list' | 'record'): ValueView => ({
  kind: 'ref',
  id,
  type,
  preview: type === 'list' ? '[1, 2, 3]' : '{name: "ada"}',
})

function fixture(heap: ObjectView[], truncated = false): StateView {
  return {
    time: 0,
    location: null,
    frames: [
      {
        uid: 1,
        name: '<top level>',
        protoId: 0,
        ip: 0,
        library: false,
        source: 'main',
        span,
        stmtSpan: span,
        line: 1,
        locals: [
          {
            name: 'xs',
            slot: 0,
            kind: 'let',
            mutable: false,
            value: heap.length > 0 ? ref(1, 'list') : num(7),
            declSpan: span,
            target: { kind: 'local', frameUid: 1, slot: 0 },
          },
        ],
        captures: [],
        temps: [],
      },
    ],
    globals: [],
    heap: new Map(heap.map((object) => [object.id, object])),
    heapTruncated: truncated,
    outputCount: 0,
    error: null,
  }
}

async function renderWith(view: StateView | ((time: number) => StateView)) {
  const engine = scriptedEngine()
  const store = createStudioStore(
    { engine, storage: memoryStorage(), scheduler: new ManualScheduler(), examples: [] },
    { sharedSource: 'let xs = [1, 2, 3]' },
  )
  const recording: Recording = {
    ...fakeRecording({ length: 5000 }),
    stateAt: (time: number) => (typeof view === 'function' ? view(time) : view),
    allocationTime: (id: number) => (id === 1 ? 1204 : null),
  }
  render(
    <StudioProvider store={store}>
      <HeapGraph />
    </StudioProvider>,
  )
  await act(async () => {
    void store.getState().run()
    await engine.resolveNext(recording)
  })
  return store
}

afterEach(cleanup)

describe('HeapGraph', () => {
  test('draws roots and boxes, selects a box and jumps to its creation', async () => {
    const store = await renderWith(
      fixture(
        [
          { type: 'list', id: 1, offset: 0, items: [num(1), ref(2, 'record')], length: 2 },
          {
            type: 'record',
            id: 2,
            offset: 0,
            entries: [{ key: 'name', value: { kind: 'string', value: 'ada' } }],
            length: 1,
          },
        ],
        true,
      ),
    )
    expect(screen.getByText('xs')).toBeTruthy()
    expect(screen.getByText('2 objects')).toBeTruthy()
    expect(screen.getByText('"ada"')).toBeTruthy()
    expect(screen.getByText(/heap view limit/)).toBeTruthy()
    expect(document.querySelectorAll('.hp-edge')).toHaveLength(2)

    const list = screen.getByRole('button', { name: 'list [2], object 1' })
    fireEvent.mouseEnter(list)
    expect(document.querySelectorAll('.hp-edge.is-hot')).toHaveLength(2)
    fireEvent.click(list)
    expect(screen.getByRole('status').textContent).toContain('created at step 1,204')
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }))
    expect(store.getState().time).toBe(1204)

    fireEvent.click(screen.getByRole('button', { name: 'record {1}, object 2' }))
    expect(screen.getByRole('status').textContent).toContain('creation step not recorded')
    fireEvent.click(screen.getByRole('button', { name: 'Close object details' }))
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fit graph to panel' }))
  })

  test('the row readout follows the pen while the row stays hovered', async () => {
    const at = (t: number) =>
      fixture([{ type: 'list', id: 1, offset: 0, items: [num(t * 10)], length: 1 }])
    const store = await renderWith(at)
    act(() => store.getState().seek(3))
    const row = document.querySelector('.hp-row')!
    fireEvent.mouseEnter(row)
    expect(document.querySelector('.hp-readout')?.textContent).toContain('= 30')
    act(() => store.getState().seek(7))
    expect(document.querySelector('.hp-readout')?.textContent).toContain('= 70')
    fireEvent.mouseLeave(document.querySelector('.hp-row')!)
    expect(document.querySelector('.hp-readout')).toBeNull()
  })

  test('explains an empty heap', async () => {
    await renderWith(fixture([]))
    expect(screen.getByText('No objects yet')).toBeTruthy()
    expect(screen.getByText(/reachable from the selected frame and globals/)).toBeTruthy()
  })
})
