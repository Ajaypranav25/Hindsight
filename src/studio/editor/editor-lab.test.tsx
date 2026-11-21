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
import { labMarks } from './lab-gutter'
import { idleCodeLines, whyNotGuardLine, whyNotMoment } from './lab-lines'
import { liveStudio } from './studio-field'

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

/**
 * The lab gutter's marks as [line, kind]: the kinds drawn in the gutter (jsdom has no layout to
 * tell lines apart by), each paired with its line from the overlay the gutter draws.
 */
const gutterMarks = (container: HTMLElement, editor: EditorView) => {
  const drawn = [...container.querySelectorAll('.ed-gutter-lab .ed-lab-mark')]
    .map((cell) => /ed-lab-(cause|effect|guard)/.exec(cell.className)?.[1])
    .filter((kind) => kind !== undefined)
  const overlay = liveStudio(editor.state)?.overlay
  const lines = labMarks(
    editor.state.doc.lines,
    overlay?.keepLines ?? null,
    overlay?.effectLine ?? null,
    overlay?.guardLine ?? null,
  )
  const marks = [...lines].sort((a, b) => a[0] - b[0])
  expect(drawn).toEqual(marks.map(([, kind]) => kind))
  return marks
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

  test('the heat gutter marks them, and asking explains under the line', async () => {
    // Arrange
    const { store, container, editor, recording } = setup(SHIPPING)
    expect(container.querySelectorAll('.ed-heat-idle')).toHaveLength(2)
    // Act
    act(() => store.getState().askWhyNot(4))
    // Assert: a block widget right after line 4, laid out from the structured fields.
    const note = screen.getByRole('group', { name: 'Why line 4 did not run' })
    expect(note.closest('.cm-content')).not.toBeNull()
    expect(note.previousElementSibling?.textContent).toBe('  print("free shipping")')
    const mark = liveWhyNot(store.getState().lab, recording)!
    if (mark.why.kind !== 'guard') throw new Error('expected a guard')
    const set = mark.why.operands[0]!.origin!
    expect(note.textContent).toContain(
      `if total > 80 was false at step ${mark.why.time} because total was 75, set at step ${set.time} (line 2).`,
    )
    await waitFor(() => expect(document.activeElement).toBe(note))
    // The guard's line is marked, in the text and with a gutter badge.
    expect(container.querySelectorAll('.cm-line')[2]!.classList.contains('ed-line-guard')).toBe(
      true,
    )
    expect(gutterMarks(container, editor)).toEqual([[3, 'guard']])
    expect(whyNotGuardLine(mark.why)).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: 'Go to where it was set' }))
    expect(store.getState().time).toBe(set.time + 1)
    fireEvent.click(screen.getByRole('button', { name: 'Go to the decision' }))
    expect(store.getState().time).toBe(whyNotMoment(mark.why))
    expect(recording.locationAt(store.getState().time)?.opName).toBe('JumpIfFalse')
    fireEvent.keyDown(screen.getByRole('group', { name: 'Why line 4 did not run' }), {
      key: 'Escape',
    })
    expect(screen.queryByRole('group', { name: 'Why line 4 did not run' })).toBeNull()
    expect(container.querySelector('.ed-line-guard')).toBeNull()
    expect(document.activeElement?.classList.contains('cm-content')).toBe(true)
  })

  test('an uncalled function and a line that ran are explained in sentences', () => {
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

  test('an uncalled function whose call site was skipped lays out that guard', () => {
    const source =
      'fn shout(s) {\n  print(s)\n}\nlet loud = false\nif loud {\n  shout("hi")\n}\nprint(1)\n'
    const { store } = setup(source)
    act(() => store.getState().askWhyNot(2))
    const note = screen.getByRole('group', { name: 'Why line 2 did not run' })
    expect(note.textContent).toContain('did not run.')
    expect(note.textContent).toMatch(/if loud was false at step \d+ because loud was false/)
  })

  test('editing the program closes the explanation', () => {
    const { store, editor } = setup(SHIPPING)
    act(() => store.getState().askWhyNot(4))
    expect(screen.getByRole('group', { name: 'Why line 4 did not run' })).toBeTruthy()
    act(() => editor.dispatch({ changes: { from: 0, insert: '\n' } }))
    expect(screen.queryByRole('group', { name: 'Why line 4 did not run' })).toBeNull()
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

  test('"What led here?" marks causes and the effect and lists the chain until dismissed', async () => {
    // Arrange
    const source = 'let a = 1\nlet b = 2\nlet c = a + 10\nprint(c)\n'
    const recording = recordSource(source)
    const at = recording.outputs[0]!.time
    const { store, container, editor } = setup(source, at)
    expect(wantedSliceStep(store.getState())).toBeNull()
    // Act
    fireEvent.click(screen.getByRole('button', { name: 'What led here?' }))
    // Assert: the others dimmed, a causal bar on each cause and the effect on line 4.
    await screen.findByText(`3 lines led to step ${at}; the rest are dimmed`)
    expect(dimmed(container)).toEqual([2, 5])
    expect(gutterMarks(container, editor)).toEqual([
      [1, 'cause'],
      [3, 'cause'],
      [4, 'effect'],
    ])
    const chain = screen.getByRole('list', { name: 'Causal chain, newest first' })
    const links = [...chain.querySelectorAll('button')].map((link) => link.textContent)
    expect(links[0]).toMatch(/^c = 11 · step \d+ · line 3$/)
    expect(links[1]).toMatch(/^a = 1 · step \d+ · line 1$/)
    // A link moves the pen; the slice stays while the pen explores its causes.
    fireEvent.click(chain.querySelector('button')!)
    expect(store.getState().time).toBeLessThan(at)
    expect(dimmed(container)).toEqual([2, 5])
    expect(screen.getByRole('button', { name: 'What led here?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show all lines' }))
    expect(dimmed(container)).toEqual([])
    expect(gutterMarks(container, editor)).toEqual([])
  })

  test('a step traced from a console line is named after the line in the chip', async () => {
    const source = 'let a = 1\nprint(a)\nprint(a + 1)\n'
    const recording = recordSource(source)
    const { store } = setup(source)
    act(() => store.getState().sliceFrom(recording.outputs[1]!.time, 'output line 2'))
    await screen.findByText('2 lines led to output line 2; the rest are dimmed')
  })

  test('nothing is traced for a stale recording', () => {
    const { store, container } = setup(CRASH)
    act(() => store.getState().setSource(`${CRASH}\n`))
    expect(wantedSliceStep(store.getState())).toBeNull()
    expect(container.querySelector('.ed-slice')).toBeNull()
  })
})
