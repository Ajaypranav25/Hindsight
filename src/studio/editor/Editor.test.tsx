// @vitest-environment jsdom
import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { memoryStorage } from '../lib/storage'
import { StudioProvider } from '../state/context'
import { ManualScheduler } from '../state/scheduler'
import { createStudioStore } from '../state/store'
import { scriptedEngine } from '../state/testing'
import { Editor } from './Editor'

const SOURCE = 'fn sq(n) {\n  let r = n * n\n  return r\n}\nlet a = sq(3)\nprint(a)\n'

beforeAll(() => {
  // jsdom has no layout; CodeMirror measures text through these.
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
  Range.prototype.getClientRects ??= empty as unknown as () => DOMRectList
  Range.prototype.getBoundingClientRect ??= rect as unknown as () => DOMRect
})

afterEach(cleanup)

function realRecording(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('fixture does not compile')
  return record(compiled.program)
}

function setup() {
  const engine = scriptedEngine()
  const store = createStudioStore(
    { engine, storage: memoryStorage(), scheduler: new ManualScheduler(), examples: [] },
    { sharedSource: SOURCE },
  )
  const { container } = render(
    <StudioProvider store={store}>
      <Editor />
    </StudioProvider>,
  )
  const editor = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
  return { engine, store, container, editor }
}

describe('Editor', () => {
  test('shows the source with lexer highlighting and echoes user edits to the store', () => {
    const { store, container, editor } = setup()
    expect(editor.state.doc.toString()).toBe(SOURCE)
    expect(container.querySelector('.ed-syn-keyword')?.textContent).toBe('fn')
    expect(container.querySelector('.ed-syn-builtin')?.textContent).toBe('print')
    act(() => editor.dispatch({ changes: { from: SOURCE.length, insert: 'print(1)\n' } }))
    expect(store.getState().source).toBe(`${SOURCE}print(1)\n`)
  })

  test('external source changes replace the document without echoing back', () => {
    const { engine, store, editor } = setup()
    const compiles = engine.compiled.length
    act(() => store.getState().setSource('print(2)\n'))
    expect(editor.state.doc.toString()).toBe('print(2)\n')
    expect(engine.compiled.length).toBe(compiles + 1)
  })

  test('draws the pen, value hints and heat, and hides them when stale', async () => {
    const { engine, store, container, editor } = setup()
    const recording = realRecording(SOURCE)
    await act(async () => {
      void store.getState().run()
      await engine.resolveNext(recording)
    })
    act(() => store.getState().seek(recording.lineHits(3)[0]!))
    expect(container.querySelector('.ed-line-current')?.textContent).toContain('return r')
    expect(container.querySelector('.ed-span-current')).not.toBeNull()
    const hints = [...container.querySelectorAll('.ed-hint')].map((h) => h.textContent)
    expect(hints).toEqual(['n = 3', 'r = 9'])
    expect(container.querySelectorAll('.ed-heat:not(.ed-heat-spacer)').length).toBeGreaterThan(0)
    act(() => editor.dispatch({ changes: { from: 0, insert: '// edited\n' } }))
    expect(container.querySelector('.ed-line-current')).toBeNull()
    expect(container.querySelector('.ed-hint')).toBeNull()
    expect(container.querySelector('.ed-heat:not(.ed-heat-spacer)')).toBeNull()
  })

  test('compile diagnostics become lint squiggles', () => {
    const { store, container } = setup()
    act(() => store.getState().setSource('let x = ERROR\n'))
    const squiggle = container.querySelector('.cm-lintRange-error')
    expect(squiggle?.textContent).toBe('ERROR')
  })

  test('clicking the breakpoint gutter toggles a breakpoint', () => {
    const { store, container } = setup()
    const cell = container.querySelector('.ed-gutter-bp .cm-gutterElement:not(:first-child)')
    expect(cell).not.toBeNull()
    fireEvent.mouseDown(cell!, { button: 0 })
    expect(store.getState().breakpoints.size).toBe(1)
    expect(container.querySelector('.ed-bp-dot')).not.toBeNull()
  })

  test('the library chip explains library code', async () => {
    const source = 'let xs = map([1, 2], fn(x) { x * 2 })\nprint(xs)\n'
    const { engine, store } = setup()
    act(() => store.getState().setSource(source))
    const recording = realRecording(source)
    await act(async () => {
      void store.getState().run()
      await engine.resolveNext(recording)
    })
    let libraryTime = -1
    for (let t = 0; t < recording.length && libraryTime < 0; t++)
      if (recording.locationAt(t)?.source === 'prelude') libraryTime = t
    act(() => store.getState().seek(libraryTime))
    const chip = screen.getByRole('button', { name: /in library/i })
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/library function/)).not.toBeNull()
  })
})
