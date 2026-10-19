// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { compile, record } from '../core/index'
import { App } from './App'
import { memoryStorage } from './lib/storage'
import { StudioProvider } from './state/context'
import { ManualScheduler } from './state/scheduler'
import { createStudioStore } from './state/store'
import { scriptedEngine } from './state/testing'

const SOURCE =
  'fn sq(x) { x * x }\nvar total = 0\nfor i in 0..3 {\n  total += sq(i)\n}\nprint(total)\n'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderApp() {
  const engine = scriptedEngine()
  const store = createStudioStore(
    { engine, storage: memoryStorage(), scheduler: new ManualScheduler(), examples: [] },
    { sharedSource: SOURCE },
  )
  render(
    <StudioProvider store={store}>
      <App />
    </StudioProvider>,
  )
  const compiled = compile(SOURCE)
  if (!compiled.ok) throw new Error('fixture does not compile')
  await act(async () => {
    void store.getState().run()
    await engine.resolveNext(record(compiled.program))
  })
  return store
}

describe('App', () => {
  test('desktop: header, editor, stacked collapsible panels, transport and chart', async () => {
    const store = await renderApp()
    expect(screen.getByText('Hindsight')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Program editor' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Strip chart' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Transport' })).toBeTruthy()
    for (const title of ['Call stack', 'Variables', 'Heap', 'Console'])
      expect(screen.getByRole('button', { name: title })).toBeTruthy()
    const heap = screen.getByRole('button', { name: 'Heap' })
    fireEvent.click(heap)
    expect(heap.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('Finished')).toBeTruthy()
    expect(store.getState().recording).not.toBeNull()
  })

  test('narrow screens show the panels as tabs', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    await renderApp()
    const tabs = within(screen.getByRole('tablist', { name: 'Instruments' })).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Call stack',
      'Variables',
      'Heap',
      'Console',
    ])
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' })
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel')).toBeTruthy()
  })
})
