// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { setAnalysisService } from '../analysis/service'
import { renderWithRecording } from '../panels/test-fixtures'
import { fakeRecording } from '../state/testing'
import type { EditRun } from '../state/types'
import { EDIT_DIFF_MAX_STEPS, EditDiffStrip, summaryParts } from './EditDiffStrip'
import type { EditDiffSummary } from './insight-protocol'

const BEFORE = 'fn double(x) {\n  x * 2\n}\nfor i in [1, 2, 3, 4] { print(double(i)) }\n'
const AFTER = BEFORE.replace('x * 2', 'x * 3')

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

/** Renders the strip with `after` shown as the re-recording of an edit of `before`. */
function renderEdit(before: Recording, after: Recording, place: EditRun['place'] = null) {
  const rendered = renderWithRecording(<EditDiffStrip />, after)
  const source = after.program.source
  act(() =>
    rendered.store.setState({
      source,
      recordedSource: source,
      editRun: { previous: before, recording: after, place },
    }),
  )
  return rendered
}

afterEach(() => {
  cleanup()
  setAnalysisService(null)
})

describe('the "Since your edit" strip', () => {
  test('sums up what changed, and Show lists where it starts and the changed calls', async () => {
    const after = recordSource(AFTER)
    const { store } = renderEdit(recordSource(BEFORE), after, {
      call: 'double',
      precision: 'line',
    })

    const strip = await screen.findByRole('region', { name: 'Since your edit' })

    expect(strip.textContent).toContain(
      'output −3 +3 · starts in double · 5 changed calls · pen kept in double',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByRole('heading', { name: 'Where the change starts' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Changed calls' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Output' })).toBeTruthy()
    const call = screen.getAllByRole('button', { name: /double\(x = 2\)/ })[0]!
    expect(call.textContent).toContain('returned 4 → returned 6')
    fireEvent.click(call)
    expect(after.locationAt(store.getState().time)!.functionName).toBe('double')
    fireEvent.click(screen.getByRole('button', { name: '+ 9' }))
    expect(store.getState().time).toBe(after.outputs.find((o) => o.text === '9')!.time)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByRole('heading', { name: 'Changed calls' })).toBeNull()
  })

  test('says when the program behaves the same, and can be dismissed', async () => {
    renderEdit(recordSource(BEFORE), recordSource(`${BEFORE}// a note\n`))

    const strip = await screen.findByRole('region', { name: 'Since your edit' })

    expect(strip.textContent).toContain('behaves the same')
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the behaviour diff' }))
    expect(screen.queryByRole('region', { name: 'Since your edit' })).toBeNull()
  })

  test('stays away while the program is being edited, for long runs and without an edit', async () => {
    const before = recordSource(BEFORE)
    const { store } = renderEdit(before, recordSource(AFTER))
    await screen.findByRole('region', { name: 'Since your edit' })

    act(() => store.setState({ source: `${AFTER}\n` }))
    expect(screen.queryByRole('region', { name: 'Since your edit' })).toBeNull()

    const long = { ...fakeRecording({ length: EDIT_DIFF_MAX_STEPS + 1 }), program: before.program }
    act(() =>
      store.setState({
        source: AFTER,
        editRun: { previous: long, recording: store.getState().recording!, place: null },
      }),
    )
    expect(screen.queryByRole('region', { name: 'Since your edit' })).toBeNull()

    act(() => store.setState({ editRun: null }))
    expect(screen.queryByRole('region', { name: 'Since your edit' })).toBeNull()
  })

  test('shows nothing when the diff could not be made', async () => {
    let asked = 0
    setAnalysisService({
      analyze: async () => {
        asked += 1
        return { kind: 'runDiff', diff: null }
      },
    })
    renderEdit(recordSource(BEFORE), recordSource(AFTER))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })

    expect(asked).toBe(1)
    expect(screen.queryByRole('region', { name: 'Since your edit' })).toBeNull()
  })
})

describe('the summary line', () => {
  const base: EditDiffSummary = {
    same: false,
    sameOutcome: false,
    removed: 0,
    added: 0,
    outputLines: [],
    origins: [],
    originsTotal: 0,
    changed: [],
    changedTotal: 0,
    onlyOld: 1,
    onlyNew: 0,
    truncated: false,
  }
  const edit = (place: EditRun['place']): EditRun => ({
    previous: fakeRecording({ length: 1 }),
    recording: fakeRecording({ length: 1 }),
    place,
  })

  test('names an outcome change and calls that were added or are gone', () => {
    expect(summaryParts(base, edit(null))).toEqual(['the outcome changed', '1 call added or gone'])
    expect(summaryParts({ ...base, onlyNew: 2 }, edit(null))).toContain('3 calls added or gone')
  })

  test('a pen that could not be placed precisely is not claimed as kept', () => {
    const clamped = summaryParts(base, edit({ call: '<top level>', precision: 'clamped' }))
    const kept = summaryParts(base, edit({ call: 'main', precision: 'call' }))

    expect(clamped.some((part) => part.startsWith('pen kept'))).toBe(false)
    expect(kept).toContain('pen kept in main')
  })
})
