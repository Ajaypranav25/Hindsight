// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { AnalysisCancelled } from '../analysis/local'
import { setAnalysisService } from '../analysis/service'
import { renderWithRecording } from '../panels/test-fixtures'
import { liveQuery } from '../state/lab'
import { programNames, queryExamples, queryPlaceholder } from './query-examples'
import { QUERY_FAILED, QueryBar } from './QueryBar'

afterEach(() => {
  cleanup()
  setAnalysisService(null)
})

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

const ORDER =
  'fn fib(n) {\n  if n < 2 { return n }\n  return fib(n - 1) + fib(n - 2)\n}\n' +
  'var order = {paid: false, total: 3}\norder.paid = true\nprint(fib(10))\n'

describe('example queries', () => {
  test('are written with the names of the program', () => {
    expect(programNames(ORDER)).toEqual({ fn: 'fib', field: 'order.paid', variable: 'order' })
    expect(queryExamples(ORDER).map((example) => example.text)).toEqual([
      'when depth > 2',
      'changed(order.paid)',
      'calls(fib) where ret > 20',
    ])
  })

  test('prefer a variable that is written again, and ignore names in comments and strings', () => {
    const source =
      '// fn fake(x)\nlet limit = 3\nvar total = 0\ntotal += limit\nprint("fn nope()")\n'
    expect(programNames(source)).toEqual({ fn: null, field: null, variable: 'total' })
    expect(queryExamples(source).map((example) => example.text)).toEqual([
      'when total > 10',
      'changed(total)',
    ])
  })

  test('fall back to the first declaration, and to the step without any name', () => {
    expect(programNames('let a = 1\nlet b = a\n').variable).toBe('a')
    expect(queryExamples('print(1)\n').map((example) => example.text)).toEqual(['when step > 10'])
    expect(queryPlaceholder(queryExamples(ORDER))).toBe(
      'when depth > 2 · changed(order.paid) · calls(fib) where ret > 20',
    )
  })
})

describe('the query bar examples menu', () => {
  test('lists one query per form and runs the one chosen', async () => {
    const recording = recordSource(ORDER)
    const { store } = renderWithRecording(<QueryBar />, recording, 0)
    const input = screen.getByRole('textbox', { name: 'Query' }) as HTMLInputElement
    expect(input.placeholder).toBe(
      'when depth > 2 · changed(order.paid) · calls(fib) where ret > 20',
    )
    const button = screen.getByRole('button', { name: 'Query examples' })
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const items = within(screen.getByRole('menu', { name: 'Example queries' })).getAllByRole(
      'menuitem',
    )
    expect(items).toHaveLength(3)
    fireEvent.click(items[2]!)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(input.value).toBe('calls(fib) where ret > 20')
    expect(document.activeElement).toBe(input)
    await screen.findByText('4 calls')
    expect(liveQuery(store.getState().lab, recording)?.text).toBe('calls(fib) where ret > 20')
  })

  test('the button closes the open menu, and Escape gives focus back to it', () => {
    renderWithRecording(<QueryBar />, recordSource(ORDER), 0)
    const button = screen.getByRole('button', { name: 'Query examples' })
    fireEvent.click(button)
    fireEvent.mouseDown(button)
    fireEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(button)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
  })
})

describe('the query bar and the analysis service', () => {
  function ask(text: string) {
    const input = screen.getByRole('textbox', { name: 'Query' })
    fireEvent.change(input, { target: { value: text } })
    fireEvent.submit(input.closest('form')!)
  }

  test('a query the service cannot run says so', async () => {
    setAnalysisService({ analyze: () => Promise.reject(new Error('boom')) })
    renderWithRecording(<QueryBar />, recordSource(ORDER), 0)
    ask('changed(order)')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(QUERY_FAILED))
  })

  test('a cancelled query leaves no message, and an answer of another kind is ignored', async () => {
    let answers = 0
    setAnalysisService({
      analyze: () => {
        answers++
        return answers === 1
          ? Promise.reject(new AnalysisCancelled())
          : Promise.resolve({ kind: 'slice', slice: null })
      },
    })
    renderWithRecording(<QueryBar />, recordSource(ORDER), 0)
    ask('changed(order)')
    await waitFor(() => expect(answers).toBe(1))
    expect(screen.getByRole('alert').textContent).toBe('')
    ask('changed(order.paid)')
    await waitFor(() => expect(answers).toBe(2))
    expect(screen.getByRole('alert').textContent).toBe('')
    expect(screen.getByText('Searching…')).toBeTruthy()
  })
})
