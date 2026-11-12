// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { BugFinder } from './BugFinder'
import { RepairPreviews } from './RepairPreviews'
import { renderWithRecording } from './test-fixtures'

afterEach(cleanup)

const AVERAGE =
  'fn total(scores) {\n  var sum = 0\n  for s in scores { sum += s }\n  sum\n}\n' +
  'fn average(scores) {\n  total(scores) / (len(scores) + 1)\n}\n' +
  'print(average([90, 80, 100]))\n'

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

describe('the bug finder asks by halving and previews repairs', () => {
  test('a question says how many calls are still under suspicion', () => {
    const recording = recordSource(AVERAGE)
    const { store } = renderWithRecording(<BugFinder />, recording)
    expect(store.getState().bugFinder.strategy).toBe('divide')
    act(() => store.getState().startBugFinder())
    expect(screen.getByText('3 calls still under suspicion.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }))
    expect(screen.getByText('2 calls still under suspicion.')).toBeTruthy()
  })

  test('the strategy button switches to call order and starts the interview over', () => {
    const recording = recordSource(AVERAGE)
    const { store } = renderWithRecording(<BugFinder />, recording)
    act(() => store.getState().startBugFinder())
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }))
    const toggle = screen.getByRole('button', { name: 'Halve the suspects' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(store.getState().bugFinder.strategy).toBe('top-down')
    expect(store.getState().bugFinder.session?.finder.strategy).toBe('top-down')
    expect(screen.getByRole('heading', { name: 'Question 1' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Halve the suspects' }).getAttribute('aria-pressed'),
    ).toBe('false')
  })

  test('the verdict offers one-token repairs; applying one replaces the program', async () => {
    const recording = recordSource(AVERAGE)
    const { store } = renderWithRecording(<BugFinder />, recording)
    act(() => store.getState().startBugFinder())
    // average is wrong; total is right.
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }))
    fireEvent.click(screen.getByRole('button', { name: 'Right' }))
    expect(screen.getByRole('heading', { name: 'Verdict' })).toBeTruthy()
    const previews = await screen.findByRole('region', { name: 'Repair previews' })
    expect(previews.textContent).toContain('agree with your answers')
    expect(previews.textContent).toContain('+ total(scores) / (len(scores) + 0)')
    expect(previews.textContent).toContain('average(scores = [90, 80, 100]) now returned 90')
    const fix = [...previews.querySelectorAll('li')].find((row) =>
      row.textContent?.includes('(len(scores) + 0)'),
    )!
    fireEvent.click(fix.querySelector('button')!)
    expect(store.getState().source).toBe(AVERAGE.replace('+ 1)', '+ 0)'))
  })

  test('a crash: the previews are checked against the run finishing', async () => {
    const recording = recordSource('fn last(xs) {\n  xs[len(xs) - 0]\n}\nprint(last([4, 5]))\n')
    renderWithRecording(
      <RepairPreviews
        recording={recording}
        request={{ kind: 'crash' }}
        basis="the run finishing"
      />,
      recording,
    )
    expect(screen.getByText('Looking for a one-token fix…')).toBeTruthy()
    const previews = await screen.findByRole('region', { name: 'Repair previews' })
    expect(previews.textContent).toContain('This one-token change agrees with the run finishing')
    expect(previews.textContent).toContain('+ xs[len(xs) - 1]')
  })

  test('nothing is shown when no repair is found', async () => {
    const recording = recordSource('fn f(x) {\n  x\n}\nprint(f(nil) + 1)\n')
    const { container } = renderWithRecording(
      <RepairPreviews recording={recording} request={{ kind: 'crash' }} basis="x" />,
      recording,
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 80)))
    expect(container.textContent).toBe('')
  })
})
