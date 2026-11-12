// @vitest-environment jsdom
import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { commandForKey, NO_FOCUS, runCommand } from '../lib/shortcuts'
import { memoryStorage } from '../lib/storage'
import { StudioProvider } from '../state/context'
import { activeSlice, liveWhyNot, wantedSliceStep } from '../state/lab'
import { ManualScheduler } from '../state/scheduler'
import { createStudioStore } from '../state/store'
import { scriptedEngine } from '../state/testing'
import { Editor } from './Editor'
import { idleCodeLines, whyNotGuardLine, whyNotMoment } from './lab-lines'

beforeAll(() => {
  // jsdom has no layout; CodeMirror measures text through these.
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
  Range.prototype.getClientRects ??= empty as unknown as () => DOMRectList
  Range.prototype.getBoundingClientRect ??= rect as unknown as () => DOMRect
})

afterEach(cleanup)

const SHIPPING =
  'var total = 50\ntotal = total + 25\nif total > 80 {\n  print("free shipping")\n}\n' +
  'fn unused() {\n  print("never")\n}\nprint(total)\n'

const CRASH = 'let xs = [1, 2, 3]\nlet i = 5\nlet k = 9\nprint(xs[i])\n'

function recordSource(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('fixture does not compile')
  return record(compiled.program)
}

function setup(source: string, time?: number) {
  const recording = recordSource(source)
  const store = createStudioStore(
    {
      engine: scriptedEngine(),
      storage: memoryStorage(),
      scheduler: new ManualScheduler(),
      examples: [],
    },
    { sharedSource: source },
  )
  store.setState({
    recording,
    recordedSource: source,
    time: time ?? recording.length,
    status: { kind: 'ready' },
  })
  const { container } = render(
    <StudioProvider store={store}>
      <Editor />
    </StudioProvider>,
  )
  const editor = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
  return { store, container, editor, recording }
}

const dimmed = (container: HTMLElement) =>
  [...container.querySelectorAll('.cm-line')]
    .map((line, i) => (line.classList.contains('ed-line-dim') ? i + 1 : 0))
    .filter((line) => line > 0)

describe('lines that did not run', () => {
  test('idle lines are the statements no step started on', () => {
    expect([...idleCodeLines(recordSource(SHIPPING))].sort()).toEqual([4, 7])
    expect([...idleCodeLines(recordSource('print(1)\n'))]).toEqual([])
  })

  test('the heat gutter marks them, and asking explains with a way to the decision', () => {
    const { store, container, recording } = setup(SHIPPING)
    expect(container.querySelectorAll('.ed-heat-idle')).toHaveLength(2)
    act(() => store.getState().askWhyNot(4))
    const note = screen.getByRole('group', { name: 'Why line 4 did not run' })
    expect(note.textContent).toContain('`total > 80` was false (total was 75')
    expect(document.activeElement).toBe(note)
    // The guard's line is marked while the note is open.
    expect(container.querySelectorAll('.cm-line')[2]!.classList.contains('ed-line-guard')).toBe(
      true,
    )
    const mark = liveWhyNot(store.getState().lab, recording)!
    expect(whyNotGuardLine(mark.why)).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: 'Go to the decision' }))
    expect(store.getState().time).toBe(whyNotMoment(mark.why))
    expect(recording.locationAt(store.getState().time)?.opName).toBe('JumpIfFalse')
    fireEvent.keyDown(note, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Why line 4 did not run' })).toBeNull()
    expect(container.querySelector('.ed-line-guard')).toBeNull()
  })

  test('a function nobody called has no moment to go to; a line that ran says so', () => {
    const { store } = setup(SHIPPING)
    act(() => store.getState().askWhyNot(7))
    expect(screen.getByRole('group', { name: 'Why line 7 did not run' }).textContent).toContain(
      'nothing in the program calls it by name',
    )
    expect(screen.queryByRole('button', { name: 'Go to the decision' })).toBeNull()
    act(() => store.getState().askWhyNot(9))
    expect(screen.getByRole('group', { name: 'Why line 9 did not run' }).textContent).toContain(
      'Line 9 did run',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(store.getState().lab.whyNot).toBeNull()
  })

  test('Shift+F9 asks about the cursor line; nothing is asked of a stale recording', () => {
    const { store } = setup(SHIPPING)
    const command = commandForKey(
      { key: 'F9', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false },
      NO_FOCUS,
    )
    expect(command).toEqual({ kind: 'why-not' })
    expect(runCommand(command!, store.getState(), null)).toBe(false)
    act(() => void runCommand(command!, store.getState(), 4))
    expect(store.getState().lab.whyNot?.line).toBe(4)
    act(() => {
      store.getState().closeWhyNot()
      store.getState().setSource(`${SHIPPING}\n`)
      store.getState().askWhyNot(4)
    })
    expect(store.getState().lab.whyNot).toBeNull()
  })
})

describe('lines that led here', () => {
  test('after a crash, the lines with no part in it are dimmed', async () => {
    const { store, container, recording } = setup(CRASH)
    expect(wantedSliceStep(store.getState())).toBe(recording.length)
    expect(screen.getByText('Tracing causes…')).toBeTruthy()
    await screen.findByText('3 lines led to the error; the rest are dimmed')
    expect([...activeSlice(store.getState())!.lines!].sort()).toEqual([1, 2, 4])
    expect(dimmed(container)).toEqual([3, 5])
    fireEvent.click(screen.getByRole('button', { name: 'Show all lines' }))
    expect(dimmed(container)).toEqual([])
    expect(store.getState().lab.dimming).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Dim unrelated lines' }))
    await waitFor(() => expect(dimmed(container)).toEqual([3, 5]))
  })

  test('"What led here?" traces the pen\'s step until the pen moves', async () => {
    const source = 'let a = 1\nlet b = 2\nlet c = a + 10\nprint(c)\n'
    const recording = recordSource(source)
    const at = recording.outputs[0]!.time
    const { store, container } = setup(source, at)
    expect(wantedSliceStep(store.getState())).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'What led here?' }))
    await screen.findByText(`3 lines led to step ${at}; the rest are dimmed`)
    expect(dimmed(container)).toEqual([2, 5])
    act(() => store.getState().seek(at - 1))
    expect(dimmed(container)).toEqual([])
    expect(screen.getByRole('button', { name: 'What led here?' })).toBeTruthy()
  })

  test('nothing is traced for a stale recording', () => {
    const { store, container } = setup(CRASH)
    act(() => store.getState().setSource(`${CRASH}\n`))
    expect(wantedSliceStep(store.getState())).toBeNull()
    expect(container.querySelector('.ed-slice')).toBeNull()
  })
})
