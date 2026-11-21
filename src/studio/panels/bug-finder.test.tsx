// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { App } from '../App'
import { FindBug } from '../chrome/FindBug'
import { memoryStorage } from '../lib/storage'
import { StudioProvider } from '../state/context'
import { ManualScheduler } from '../state/scheduler'
import { createStudioStore } from '../state/store'
import { scriptedEngine } from '../state/testing'
import { BugFinder } from './BugFinder'
import { automaticSummary, culpritLines } from './bug-finder-model'
import { renderWithRecording } from './test-fixtures'

beforeAll(() => {
  // jsdom has no layout; CodeMirror (rendered by the App tests) measures text through these.
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
  Range.prototype.getClientRects ??= empty as unknown as () => DOMRectList
  Range.prototype.getBoundingClientRect ??= rect as unknown as () => DOMRect
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CELSIUS = `fn celsius(temps) {
  map(temps, |f| (f - 32) * 5 / 6)
}
print(celsius([32, 212]))
`

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

const live = () => screen.getByRole('status').textContent

describe('BugFinder', () => {
  test('asks for a recording first', () => {
    renderWithRecording(<BugFinder />, null)
    expect(screen.getByText(/Run the program/)).toBeTruthy()
  })

  test('asks for a new run when the program changed since it was recorded', async () => {
    const engine = scriptedEngine()
    const store = createStudioStore(
      { engine, scheduler: new ManualScheduler(), storage: memoryStorage(), examples: [] },
      { sharedSource: CELSIUS },
    )
    const running = store.getState().run()
    await engine.resolveNext(recordSource(CELSIUS))
    await running
    store.getState().setSource(CELSIUS.replace('/ 6', '/ 9'))
    render(
      <StudioProvider store={store}>
        <BugFinder />
      </StudioProvider>,
    )
    expect(screen.getByText(/changed the program since it was recorded/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Run it' }))
    expect(engine.recorded).toHaveLength(2)
  })

  test('interviews the user down to the callback with the wrong formula', () => {
    const recording = recordSource(CELSIUS)
    const { store } = renderWithRecording(<BugFinder />, recording)
    act(() => store.getState().setBugFinderStrategy('top-down'))
    fireEvent.click(screen.getByRole('button', { name: 'Find the bug' }))
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    expect(screen.getByText('celsius(temps = [32, 212])')).toBeTruthy()
    expect(screen.getByText('[0, 150]')).toBeTruthy()
    expect(live()).toBe('Question 1: celsius(temps = [32, 212]) returned [0, 150]. Is that right?')
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }))
    expect(screen.getByText('lambda(f = 32)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Right' }))
    expect(screen.getByRole('heading', { name: 'Question 3' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }))
    expect(screen.getByRole('heading', { name: 'Verdict' })).toBeTruthy()
    expect(screen.getByText('Found it: the bug is in lambda (line 2).')).toBeTruthy()
    expect(live()).toBe(
      'Found it: the bug is in lambda (line 2). It makes no calls of its own, and its own result is wrong.',
    )
    expect(culpritLines(store.getState().bugFinder, recording)).toEqual({ start: 2, end: 2 })
    expect(document.activeElement?.textContent).toBe('Verdict')
  })

  test('keyboard answers, undo, show me, go to the call, start over and close', () => {
    const recording = recordSource(CELSIUS)
    const { store } = renderWithRecording(<BugFinder />, recording)
    act(() => store.getState().startBugFinder())
    const card = screen.getByRole('region', { name: 'Question 1' })
    fireEvent.keyDown(card, { key: 'w' })
    expect(screen.getByRole('heading', { name: 'Question 2' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('region', { name: 'Question 2' }), { key: 'u' })
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('region', { name: 'Question 1' }), {
      key: 'w',
      ctrlKey: true,
    })
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }))
    const session = store.getState().bugFinder.session!
    expect(store.getState().time).toBe(
      session.finder.tree.children(session.finder.start, { justMyCode: true })[0]!.exit + 1,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Right' }))
    expect(
      screen.getByText(/the bug is in the top-level code/, { selector: '.bf-found' }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go to the call' }))
    expect(store.getState().time).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close the bug finder' }))
    expect(screen.getByRole('button', { name: 'Find the bug' })).toBeTruthy()
  })

  test('after a runtime error it points at the error but can search anyway', () => {
    const recording = recordSource('fn get(xs) {\n  xs[3]\n}\nprint(get([1]))\n')
    const { store } = renderWithRecording(<BugFinder />, recording)
    expect(screen.getByText(/runtime error on line 2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go to the error' }))
    expect(store.getState().time).toBe(recording.length)
    fireEvent.click(screen.getByRole('button', { name: 'Find the bug anyway' }))
    expect(screen.getByText(/raised an error/, { selector: '.bf-outcome' })).toBeTruthy()
  })

  test('a panel that appears with a question announces it', () => {
    const recording = recordSource(CELSIUS)
    const Shown = (props: { show: boolean }) => (props.show ? <BugFinder /> : null)
    const { store, rerender } = renderWithRecording(<Shown show={false} />, recording)
    act(() => store.getState().startBugFinder())
    const observer = new MutationObserver(() => {})
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    rerender(
      <StudioProvider store={store}>
        <Shown show />
      </StudioProvider>,
    )
    const records = observer.takeRecords()
    observer.disconnect()
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/^Question 1: celsius/)
    // Screen readers ignore the text a live region arrives with; it must change once in the page.
    expect(records.some((record) => status.contains(record.target))).toBe(true)
  })

  test('during a what-if, an interview about the real run can be continued or replaced', async () => {
    const source =
      'var scale = 5\nfn half(x) {\n  x * scale / 10\n}\nprint(half(4))\nprint(half(8))\n'
    const engine = scriptedEngine()
    const store = createStudioStore(
      { engine, scheduler: new ManualScheduler(), storage: memoryStorage(), examples: [] },
      { sharedSource: source },
    )
    const running = store.getState().run()
    const recording = recordSource(source)
    await engine.resolveNext(recording)
    await running
    store.getState().openBugFinder()
    const fork = async () => {
      store.getState().seek(Math.floor(recording.length / 2))
      await store.getState().forkWhatIf({ kind: 'global', name: 'scale' }, 10, 'scale')
    }
    await fork()
    render(
      <StudioProvider store={store}>
        <BugFinder />
      </StudioProvider>,
    )
    expect(screen.getByText(/Your interview is about the real run/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue in the real run' }))
    expect(store.getState().whatIf).toBeNull()
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Question 1')
    await act(fork)
    fireEvent.click(screen.getByRole('button', { name: 'Start a new interview here' }))
    expect(store.getState().bugFinder.session?.recording).toBe(store.getState().recording)
    expect(store.getState().whatIf).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
  })

  test('offers to start from the user call at the pen', () => {
    const recording = recordSource(CELSIUS)
    const entry = recording.depthSeries().findIndex((depth) => depth === 1)
    const { store } = renderWithRecording(<BugFinder />, recording, entry + 1)
    fireEvent.click(screen.getByRole('button', { name: 'Start from the celsius call at the pen' }))
    expect(store.getState().bugFinder.session?.finder.start.name).toBe('celsius')
    expect(screen.getByText('lambda(f = 32)')).toBeTruthy()
  })
})

describe('opening the bug finder', () => {
  test('the header button starts an interview', () => {
    const { store } = renderWithRecording(<FindBug />, recordSource(CELSIUS))
    fireEvent.click(screen.getByRole('button', { name: 'Find the bug' }))
    expect(store.getState().bugFinder.reveal).toBe(1)
    expect(store.getState().bugFinder.session).not.toBeNull()
  })

  test('the header button waits for a recording', () => {
    renderWithRecording(<FindBug />, null)
    expect(screen.getByRole('button', { name: 'Find the bug' }).hasAttribute('disabled')).toBe(true)
  })

  async function renderApp() {
    const engine = scriptedEngine()
    const store = createStudioStore(
      { engine, storage: memoryStorage(), scheduler: new ManualScheduler(), examples: [] },
      { sharedSource: CELSIUS },
    )
    render(
      <StudioProvider store={store}>
        <App />
      </StudioProvider>,
    )
    await act(async () => {
      void store.getState().run()
      await engine.resolveNext(recordSource(CELSIUS))
    })
    return store
  }

  /** The header button, focused as a click would leave it. */
  function clickFindBug() {
    const button = screen.getByRole('button', { name: 'Find the bug' })
    button.focus()
    fireEvent.click(button)
  }

  test('on desktop the collapsed panel opens with the first question, focused', async () => {
    const store = await renderApp()
    const toggle = screen.getByRole('button', { name: 'Bug finder' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    clickFindBug()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Question 1')
    expect(store.getState().bugFinder.focused).toBe(1)
  })

  test('on narrow screens the bug finder tab is selected', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    await renderApp()
    expect(screen.getByRole('tab', { name: 'Bug finder' }).getAttribute('aria-selected')).toBe(
      'false',
    )
    clickFindBug()
    expect(screen.getByRole('tab', { name: 'Bug finder' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Question 1')
    // Coming back to the tab later leaves focus on the tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }))
    const tab = screen.getByRole('tab', { name: 'Bug finder' })
    tab.focus()
    fireEvent.click(tab)
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    expect(document.activeElement).toBe(tab)
  })
})

const CONTRACTS = `fn total(xs) {
  var sum = 0
  for x in xs { sum += x }
  sum
}
fn average(xs) ensures result * len(xs) == total(xs) {
  total(xs) / (len(xs) - 1)
}
assert(total([88, 83, 79]) == 250)
print(average([88, 83, 79]))
`

describe('BugFinder with contracts and assertions', () => {
  test('reaches the verdict with no questions and lists the automatic answers with reasons', () => {
    // Arrange
    const recording = recordSource(CONTRACTS)
    renderWithRecording(<BugFinder />, recording)
    expect(screen.getByText(/failed a contract or an assertion on line 6/)).toBeTruthy()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Find the bug' }))

    // Assert
    expect(screen.getByRole('heading', { name: 'Verdict' })).toBeTruthy()
    expect(screen.getByText('Found it: the bug is in average (lines 6–8).')).toBeTruthy()
    const list = screen.getByRole('region', { name: 'Answered by your contracts and assertions' })
    expect(list.textContent).toContain('(its postcondition on line 6 failed)')
    expect(list.textContent).toContain('(an identical call passed the assertion on line 9)')
    expect(
      screen.getByText(/No questions for you: your contracts and assertions answered 2 questions/),
    ).toBeTruthy()
  })

  test('undo takes an automatic answer back, and the toggle turns them off', () => {
    // Arrange
    const recording = recordSource(CONTRACTS)
    const { store } = renderWithRecording(<BugFinder />, recording)
    fireEvent.click(screen.getByRole('button', { name: 'Find the bug' }))

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    // Assert
    expect(screen.getByRole('heading', { name: 'Question 2' })).toBeTruthy()
    expect(screen.getByText('Is that right?')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: 'Use contracts and assertions' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(store.getState().bugFinder.auto).toBe(false)
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    expect(
      screen.queryByRole('region', { name: 'Answered by your contracts and assertions' }),
    ).toBeNull()
  })
})

describe('automaticSummary', () => {
  test('counts the questions contracts answered and the ones the user did', () => {
    expect(automaticSummary(3, 0)).toBeNull()
    expect(automaticSummary(0, 1)).toBe(
      'No questions for you: your contracts and assertions answered 1 question.',
    )
    expect(automaticSummary(1, 2)).toBe(
      'Your contracts and assertions answered 2 questions; you answered 1 question.',
    )
    expect(automaticSummary(4, 1)).toBe(
      'Your contracts and assertions answered 1 question; you answered 4 questions.',
    )
  })
})
