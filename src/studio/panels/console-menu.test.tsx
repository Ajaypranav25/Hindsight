// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { placeMenu } from '../chrome/ContextMenu'
import { copiedText, Console } from './Console'
import { renderWithRecording } from './test-fixtures'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PRICE =
  'let price = 200\nlet discount_rate = 0.2\nlet total = price - price * discount_rate\n' +
  'print("total: {total}")\nprint("done")\n'

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

function setup() {
  const recording = recordSource(PRICE)
  const rendered = renderWithRecording(<Console />, recording, recording.length)
  const lines = screen.getByRole('list', { name: 'Program output' })
  const lineButton = (index: number) =>
    within(lines).getAllByRole('button', { name: /^\d+/ })[index] as HTMLButtonElement
  return { ...rendered, recording, lineButton }
}

const menu = () => screen.getByRole('menu')
const items = () => within(menu()).getAllByRole('menuitem')

describe('the console line context menu', () => {
  test('a right-click opens a menu at the pointer with the four actions, first one focused', () => {
    const { lineButton } = setup()
    fireEvent.contextMenu(lineButton(0), { clientX: 40, clientY: 60 })
    expect(menu().getAttribute('aria-label')).toBe('Output line 1')
    expect(items().map((item) => item.querySelector('.ch-context-label')?.textContent)).toEqual([
      'Make this print…',
      'What led to this?',
      'Go to this moment',
      'Copy line',
    ])
    expect(document.activeElement).toBe(items()[0])
    expect(menu().style.left).toBe('40px')
  })

  test('arrow keys, Home and End move between items; Escape closes and refocuses the line', () => {
    const { lineButton } = setup()
    fireEvent.contextMenu(lineButton(1), { clientX: 10, clientY: 10 })
    fireEvent.keyDown(menu(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items()[1])
    fireEvent.keyDown(menu(), { key: 'ArrowUp' })
    fireEvent.keyDown(menu(), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items()[3])
    fireEvent.keyDown(menu(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items()[0])
    fireEvent.keyDown(menu(), { key: 'End' })
    expect(document.activeElement).toBe(items()[3])
    fireEvent.keyDown(menu(), { key: 'Home' })
    expect(document.activeElement).toBe(items()[0])
    fireEvent.keyDown(menu(), { key: 'x' })
    expect(document.activeElement).toBe(items()[0])
    fireEvent.keyDown(menu(), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(lineButton(1))
  })

  test('Shift+F10 and the ContextMenu key open it under the focused line', () => {
    const { lineButton } = setup()
    lineButton(0).focus()
    fireEvent.keyDown(lineButton(0), { key: 'F10', shiftKey: true })
    expect(menu()).toBeTruthy()
    fireEvent.keyDown(menu(), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(lineButton(0))
    fireEvent.keyDown(lineButton(0), { key: 'F10' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.keyDown(lineButton(0), { key: 'ContextMenu' })
    expect(menu()).toBeTruthy()
  })

  test('a keyboard contextmenu event (no pointer position) anchors it under the line', () => {
    const { lineButton } = setup()
    fireEvent.contextMenu(lineButton(0), { clientX: 0, clientY: 0 })
    expect(menu().style.left).toBe('16px')
  })

  test('a click elsewhere or a scroll closes it without moving focus back', () => {
    const { lineButton } = setup()
    fireEvent.contextMenu(lineButton(0), { clientX: 5, clientY: 5 })
    fireEvent.mouseDown(items()[0]!)
    expect(menu()).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(lineButton(0), { clientX: 5, clientY: 5 })
    fireEvent.scroll(document)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('Make this print… opens the form under the line', () => {
    const { lineButton } = setup()
    fireEvent.contextMenu(lineButton(0), { clientX: 5, clientY: 5 })
    fireEvent.click(items()[0]!)
    const input = screen.getByLabelText('Make this line print') as HTMLInputElement
    expect(input.value).toBe('total: 160')
    expect(document.activeElement).toBe(input)
  })

  test('What led to this? moves the pen to the line and traces the step that printed it', () => {
    const { lineButton, store, recording } = setup()
    const printed = recording.outputs[1]!.time
    fireEvent.contextMenu(lineButton(1), { clientX: 5, clientY: 5 })
    fireEvent.click(items()[1]!)
    expect(store.getState().time).toBe(printed)
    expect(store.getState().lab.sliceAt).toEqual({
      recording,
      time: printed,
      label: 'output line 2',
    })
    expect(document.activeElement).toBe(lineButton(1))
  })

  test('the line tools offer What led to this? too', () => {
    const { store, recording } = setup()
    fireEvent.click(screen.getAllByRole('button', { name: 'What led to this?' })[0]!)
    expect(store.getState().lab.sliceAt?.time).toBe(recording.outputs[0]!.time)
  })

  test('Go to this moment moves the pen to the step that printed the line', () => {
    const { lineButton, store, recording } = setup()
    fireEvent.contextMenu(lineButton(0), { clientX: 5, clientY: 5 })
    fireEvent.click(items()[2]!)
    expect(store.getState().time).toBe(recording.outputs[0]!.time)
  })

  test('Copy line writes the text to the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { lineButton } = setup()
    fireEvent.contextMenu(lineButton(0), { clientX: 5, clientY: 5 })
    fireEvent.click(items()[3]!)
    expect(writeText).toHaveBeenCalledWith('total: 160')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Output line 1 copied'))
  })

  test('without a clipboard, Copy line selects the text for a manual copy', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const { lineButton } = setup()
    fireEvent.contextMenu(lineButton(1), { clientX: 5, clientY: 5 })
    fireEvent.click(items()[3]!)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(copiedText(1, false)))
    expect(window.getSelection()?.toString()).toBe('done')
  })

  test('a refused clipboard write falls back to the selection too', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { lineButton } = setup()
    fireEvent.contextMenu(lineButton(0), { clientX: 5, clientY: 5 })
    fireEvent.click(items()[3]!)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('is selected'))
  })
})

describe('placeMenu', () => {
  test('keeps the menu inside the viewport, opening upwards when there is no room below', () => {
    expect(placeMenu({ x: 20, y: 30 }, 100, 80, 800, 600)).toEqual({ x: 20, y: 30 })
    expect(placeMenu({ x: 780, y: 30 }, 100, 80, 800, 600)).toEqual({ x: 692, y: 30 })
    expect(placeMenu({ x: 20, y: 580 }, 100, 80, 800, 600)).toEqual({ x: 20, y: 500 })
    expect(placeMenu({ x: -5, y: 10 }, 100, 700, 800, 600)).toEqual({ x: 8, y: 8 })
  })
})
