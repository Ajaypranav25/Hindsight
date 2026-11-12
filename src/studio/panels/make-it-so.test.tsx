// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { Console } from './Console'
import { renderWithRecording } from './test-fixtures'

afterEach(cleanup)

const PRICE =
  'let price = 200\nlet discount_rate = 0.2\nlet total = price - price * discount_rate\n' +
  'print("total: {total}")\n'

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

function openForm(): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name: 'Make this print…' }))
  return screen.getByLabelText('Make this line print') as HTMLInputElement
}

describe('the console asks the past for a different output', () => {
  test('the form opens under the line with its text, and Escape closes it', () => {
    renderWithRecording(<Console />, recordSource(PRICE), 5)
    const input = openForm()
    expect(input.value).toBe('total: 160')
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('Make this line print')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Make this print…' }))
  })

  test('an unchanged or empty wish does not search', () => {
    renderWithRecording(<Console />, recordSource(PRICE), 5)
    const input = openForm()
    fireEvent.submit(input.closest('form')!)
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.queryByRole('region', { name: 'Make it so' })).toBeNull()
  })

  test('answers name the earlier value, and Try it forks the run with it', async () => {
    const recording = recordSource(PRICE)
    const { store } = renderWithRecording(<Console />, recording, 5)
    const input = openForm()
    fireEvent.change(input, { target: { value: 'total: 100' } })
    fireEvent.submit(input.closest('form')!)
    const results = screen.getByRole('region', { name: 'Make it so' })
    expect(results.textContent).toContain('To get output line 1 to read "total: 100"')
    expect(results.textContent).toContain('Searching the past')
    const answer = await screen.findByText(
      /If discount_rate at step \d+ had been 0.5 instead of 0.2/,
    )
    expect(answer.textContent).toContain('line 4 would have printed total: 100.')
    expect(results.textContent).toContain('earlier values tried')
    fireEvent.click(answer.parentElement!.querySelector('button')!)
    await waitFor(() => expect(store.getState().whatIf).not.toBeNull())
    expect(store.getState().whatIf?.label).toMatch(/^discount_rate = 0.5 at step/)
    expect(store.getState().recording?.outputs[0]?.text).toBe('total: 100')
    // The wish was about the real run: its answers go when the fork is shown.
    expect(screen.queryByRole('region', { name: 'Make it so' })).toBeNull()
  })

  test('says so when no earlier value reaches the wish, and Close dismisses', async () => {
    renderWithRecording(<Console />, recordSource('print(len("abc"))\n'), 2)
    const input = openForm()
    fireEvent.change(input, { target: { value: '9' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText(/No number or true\/false value/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('region', { name: 'Make it so' })).toBeNull()
  })

  test('a runtime error can be wished away', async () => {
    const recording = recordSource('let xs = [1, 2, 3]\nlet i = 5\nprint(xs[i])\n')
    renderWithRecording(<Console />, recording, recording.length)
    fireEvent.click(screen.getByRole('button', { name: 'Make this not happen' }))
    expect(screen.getByRole('region', { name: 'Make it so' }).textContent).toContain(
      'To get this error not to happen',
    )
    const answer = await screen.findByText(/If i at step \d+ had been \d+ instead of 5/)
    expect(answer.textContent).toContain('the run would not have failed on line 3')
  })

  test('a runtime error offers one-token fixes', async () => {
    const recording = recordSource('fn last(xs) {\n  xs[len(xs) - 0]\n}\nprint(last([4, 5]))\n')
    renderWithRecording(<Console />, recording, recording.length)
    const toggle = screen.getByRole('button', { name: 'Try one-token fixes' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const previews = await screen.findByRole('region', { name: 'Repair previews' })
    expect(previews.textContent).toContain('+ xs[len(xs) - 1]')
    fireEvent.click(toggle)
    expect(screen.queryByRole('region', { name: 'Repair previews' })).toBeNull()
  })

  test('says when no one-token fix exists', async () => {
    const recording = recordSource('fn f(x) {\n  x\n}\nprint(f(nil) + 1)\n')
    renderWithRecording(<Console />, recording, recording.length)
    fireEvent.click(screen.getByRole('button', { name: 'Try one-token fixes' }))
    expect(await screen.findByText('No one-token change makes the run finish.')).toBeTruthy()
  })
})
