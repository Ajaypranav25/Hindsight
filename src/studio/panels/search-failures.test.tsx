// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { analyze, setAnalysisService } from '../analysis/service'
import { WishResults } from './MakeItSo'
import { RepairPreviews } from './RepairPreviews'
import { renderWithRecording } from './test-fixtures'

afterEach(() => {
  cleanup()
  setAnalysisService(null)
})

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

const failing = { analyze: () => Promise.reject(new Error('no memory left')) }

describe('searches the analysis service cannot run', () => {
  test('Make it so says why and offers Close', async () => {
    setAnalysisService(failing)
    const recording = recordSource('let x = 2\nprint(x)\n')
    const wish = { recording, goal: { kind: 'no-error' } as const, label: 'this' }
    renderWithRecording(<WishResults wish={wish} onClose={() => undefined} />, recording)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    await screen.findByText('The search could not be run: no memory left')
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  test('repair previews say the search could not be run', async () => {
    setAnalysisService(failing)
    const recording = recordSource('fn last(xs) {\n  xs[len(xs)]\n}\nprint(last([4, 5]))\n')
    renderWithRecording(
      <RepairPreviews recording={recording} request={{ kind: 'crash' }} basis="x" />,
      recording,
    )
    await screen.findByText('The search for one-token fixes could not be run.')
  })

  test('an answer of another kind is an error, not a result', async () => {
    setAnalysisService({ analyze: () => Promise.resolve({ kind: 'slice', slice: null }) })
    const recording = recordSource('print(1)\n')
    await expect(analyze(recording, { kind: 'query', text: 'x', limit: 1 })).rejects.toThrow(
      'The analysis answered a slice request instead of query.',
    )
  })

  test('closing a search that is still running stops it', async () => {
    let aborted = false
    setAnalysisService({
      analyze: (_recording, _request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('cancelled'))
          })
        }),
    })
    const recording = recordSource('print(1)\n')
    const wish = { recording, goal: { kind: 'no-error' } as const, label: 'this' }
    const { unmount } = renderWithRecording(
      <WishResults wish={wish} onClose={() => undefined} />,
      recording,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    unmount()
    expect(aborted).toBe(true)
  })
})
