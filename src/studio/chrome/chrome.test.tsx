// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { memoryStorage } from '../lib/storage'
import { setEditorCursorLine } from '../lib/shortcuts'
import { StudioProvider } from '../state/context'
import { ManualScheduler } from '../state/scheduler'
import { createStudioStore } from '../state/store'
import { fakeRecording, scriptedEngine } from '../state/testing'
import type { Example } from '../state/types'
import { Header } from './Header'
import { Hint } from './Hint'
import { useGlobalShortcuts } from './useGlobalShortcuts'

const EXAMPLES: readonly Example[] = [
  {
    id: 'hello',
    title: 'Hello',
    summary: 'Prints a greeting',
    source: 'print("hi")\n',
    outcome: 'finished',
    pen: 'peak',
  },
  {
    id: 'fib',
    title: 'Fibonacci',
    summary: 'Recursion as peaks',
    source: 'print(1)\n',
    outcome: 'finished',
    pen: 'peak',
  },
]

function setup(source = 'print(1)\n') {
  const engine = scriptedEngine()
  const store = createStudioStore(
    { engine, storage: memoryStorage(), scheduler: new ManualScheduler(), examples: EXAMPLES },
    { sharedSource: source },
  )
  const view = render(
    <StudioProvider store={store}>
      <Header examples={EXAMPLES} />
      <Hint />
      <ShortcutHost />
    </StudioProvider>,
  )
  return { engine, store, view }
}

function ShortcutHost() {
  useGlobalShortcuts()
  return null
}

type Setup = ReturnType<typeof setup>
type Outcome = Parameters<typeof fakeRecording>[0]['outcome']

async function finishRun(s: Setup, length = 40, outcome?: Outcome) {
  await act(async () => {
    void s.store.getState().run()
    await s.engine.resolveNext(fakeRecording({ length, outcome }))
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Header', () => {
  test('Run records the program and the status reports progress, then the result', async () => {
    const s = setup()
    fireEvent.click(screen.getByRole('button', { name: /^Run/ }))
    expect(s.engine.recorded).toHaveLength(1)
    expect(screen.getByText('Recording')).toBeTruthy()
    await act(async () => {
      await s.engine.resolveNext(fakeRecording({ length: 56_789 }))
    })
    expect(screen.getByText('Finished')).toBeTruthy()
    expect(screen.getByText(/56,789 steps · nothing printed/)).toBeTruthy()
  })

  test('the example menu lists every example and loads the chosen one', () => {
    const s = setup()
    fireEvent.click(screen.getByRole('button', { name: /Examples/ }))
    const menu = screen.getByRole('menu', { name: 'Example programs' })
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map((item) => item.textContent)).toEqual([
      'HelloPrints a greeting',
      'FibonacciRecursion as peaks',
    ])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.click(items[0]!)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(s.store.getState().exampleId).toBe('hello')
    expect(s.engine.recorded.at(-1)?.source).toBe('print("hi")\n')
    expect(screen.getByRole('button', { name: /Examples/ }).textContent).toContain('Hello')
  })

  test('Escape closes the example menu', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Examples/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('settings change the store', () => {
    const s = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const panel = screen.getByRole('dialog', { name: 'Settings' })
    fireEvent.click(within(panel).getByLabelText('10M steps'))
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Just my code/ }))
    fireEvent.click(within(panel).getByLabelText('Dark'))
    fireEvent.change(within(panel).getByLabelText('Playback speed'), { target: { value: '20' } })
    const settings = s.store.getState().settings
    expect(settings).toMatchObject({
      maxSteps: 10_000_000,
      justMyCode: false,
      theme: 'dark',
      playbackSpeed: 20,
    })
  })

  test('a runtime error is clickable and jumps to the failure', async () => {
    const s = setup('let xs = [1]\nprint(xs[3])\n')
    const error = {
      code: 'R005' as const,
      message: 'index 3 is out of bounds for a list of length 1',
      span: { start: 19, end: 24 },
      stack: [],
      time: 30,
    }
    await finishRun(s, 30, { kind: 'error', error })
    act(() => s.store.getState().seek(2))
    fireEvent.click(screen.getByRole('button', { name: /Runtime error on line 2/ }))
    expect(s.store.getState().time).toBe(30)
  })

  test('a step-limited run offers to record more', async () => {
    const s = setup()
    await finishRun(s, 500, { kind: 'step-limit', maxSteps: 500 })
    expect(screen.getByText('Stopped at the step limit')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Record 2M more' }))
    expect(s.store.getState().status.kind).toBe('recording')
  })

  test('compile errors and the stale badge', async () => {
    const s = setup()
    await finishRun(s)
    act(() => s.store.getState().updateSettings({ autoRun: false }))
    act(() => s.store.getState().setSource('print(2)\n'))
    expect(screen.getByText('Code changed · Ctrl+Enter to re-run')).toBeTruthy()
    act(() => s.store.getState().setSource('print(ERROR)\n'))
    expect(screen.getByText('1 error')).toBeTruthy()
    expect(screen.getByText(/line 1: undefined variable 'ERROR'/)).toBeTruthy()
    expect(screen.getByText('Showing the last run that compiled')).toBeTruthy()
  })

  test('notices are announced and can be dismissed', async () => {
    const s = setup()
    await finishRun(s)
    act(() => s.store.getState().jumpToOrigin({ kind: 'global', name: 'x' }, 'x'))
    expect(screen.getByText('No earlier change to x in this run')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))
    expect(s.store.getState().notice).toBeNull()
  })

  test('Copy link writes the share link to the clipboard', async () => {
    setup('print("shared")\n')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Copy a link/ }))
    })
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/#src=[A-Za-z0-9_-]+$/))
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeTruthy()
  })

  test('when the clipboard refuses, the link is shown for manual copying', async () => {
    setup()
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Copy a link/ }))
    })
    const input = within(screen.getByRole('dialog', { name: 'Copy this link' })).getByRole(
      'textbox',
    )
    expect((input as HTMLInputElement).value).toMatch(/#src=/)
  })

  test('a program too long for a link says so', () => {
    setup('print(1)\n'.repeat(8000))
    fireEvent.click(screen.getByRole('button', { name: /Copy a link/ }))
    expect(screen.getByText(/too long to fit in a link/)).toBeTruthy()
  })

  test('the help dialog traps focus and closes on Escape', () => {
    setup()
    const opener = screen.getByRole('button', { name: 'Help and shortcuts' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Help' })
    expect(within(dialog).getByText('F11')).toBeTruthy()
    expect(within(dialog).getByText('Pipes')).toBeTruthy()
    const close = within(dialog).getByRole('button', { name: 'Close help' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})

describe('Hint', () => {
  test('dismissing the hint hides it', () => {
    const s = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss hint' }))
    expect(screen.queryByRole('note')).toBeNull()
    expect(s.store.getState().hintDismissed).toBe(true)
  })
})

describe('global shortcuts', () => {
  test('function keys navigate and Ctrl+Enter runs', async () => {
    const s = setup()
    await finishRun(s, 10)
    act(() => s.store.getState().seek(4))
    fireEvent.keyDown(document.body, { key: 'F11' })
    expect(s.store.getState().time).toBe(5)
    fireEvent.keyDown(document.body, { key: 'F11', shiftKey: true })
    expect(s.store.getState().time).toBe(4)
    fireEvent.keyDown(document.body, { key: 'Home' })
    expect(s.store.getState().time).toBe(0)
    fireEvent.keyDown(document.body, { key: 'End' })
    expect(s.store.getState().time).toBe(10)
    fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true })
    expect(s.engine.recorded).toHaveLength(2)
  })

  test('shortcuts are off while the modal help dialog is open, even with focus on the body', async () => {
    const s = setup()
    await finishRun(s, 10)
    act(() => s.store.getState().seek(4))
    fireEvent.click(screen.getByRole('button', { name: 'Help and shortcuts' }))
    expect(screen.getByRole('dialog', { name: 'Help' })).toBeTruthy()
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document.body, { key: 'F11' })
    fireEvent.keyDown(document.body, { key: 'Home' })
    expect(s.store.getState().time).toBe(4)
  })

  test('F9 toggles a breakpoint on the editor cursor line', () => {
    const s = setup()
    setEditorCursorLine(3)
    const event = fireEvent.keyDown(document.body, { key: 'F9' })
    expect(event).toBe(false)
    expect([...s.store.getState().breakpoints]).toEqual([3])
    setEditorCursorLine(null)
  })

  test('typing in a text field is left alone', async () => {
    const s = setup()
    await finishRun(s, 10)
    const input = document.createElement('input')
    document.body.append(input)
    const notPrevented = fireEvent.keyDown(input, { key: 'Home' })
    expect(notPrevented).toBe(true)
    expect(s.store.getState().time).toBe(10)
    input.remove()
  })
})
