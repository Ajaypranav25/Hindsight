// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { compile, type InferResult, record, type Recording } from '../../core/index'
import { setAnalysisService } from '../analysis/service'
import { setEditorCursorLine } from '../lib/shortcuts'
import { CallStack } from '../panels/CallStack'
import { renderWithRecording } from '../panels/test-fixtures'
import { ContractsCard } from './ContractsCard'
import {
  contractsFor,
  contractsSummary,
  functionAtLine,
  functionOfProto,
  supportText,
} from './contracts-model'
import { closeContracts, contractsTarget, openContracts } from './contracts-state'

const DOUBLE = 'fn double(x) {\n  x * 2\n}\n' + 'for i in [1, 2, 3, 4] { print(double(i)) }\n'
const ONCE = 'fn once(x) {\n  x + 1\n}\nprint(once(1))\n'

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

/** Renders `ui` with `source` recorded, shown and in the editor. */
function renderFresh(ui: React.ReactElement, source: string, time = 0) {
  const recording = recordSource(source)
  const rendered = renderWithRecording(ui, recording, time)
  act(() => rendered.store.setState({ source, recordedSource: source }))
  return { ...rendered, recording }
}

afterEach(() => {
  cleanup()
  act(() => {
    closeContracts()
    setEditorCursorLine(null)
  })
  setAnalysisService(null)
})

describe('which function a request is about', () => {
  test('a fn line and a frame name the function; other lines name none', () => {
    const recording = recordSource(DOUBLE)

    const atLine = functionAtLine(recording, 1)
    const proto = recording.program.protos.find((p) => p.name === 'double')!

    expect(atLine).toMatchObject({ name: 'double', line: 1, functionStart: 0 })
    expect(functionAtLine(recording, 2)).toBeNull()
    expect(functionOfProto(recording, proto.id)?.name).toBe('double')
    expect(functionOfProto(recording, recording.program.script.id)).toBeNull()
  })

  test('the card explains a function with nothing to suggest', () => {
    const recording = recordSource(ONCE)
    const target = functionAtLine(recording, 1)!
    const result: InferResult = {
      functions: [
        {
          name: 'once',
          protoId: 1,
          functionStart: 0,
          line: 1,
          calls: 1,
          sampled: 1,
          inputs: 1,
          existing: [],
          suggestions: [],
          note: 'returned with 1 different input; at least 3 are needed',
        },
      ],
      verified: true,
      withdrawn: 0,
      problem: null,
    }

    const found = contractsFor(result, target)

    expect(contractsSummary(found, result)).toBe(
      'No contracts to suggest: once returned with 1 different input; at least 3 are needed.',
    )
    expect(contractsSummary(null, result)).toBe('This function did not take part in the run.')
    expect(contractsSummary({ ...found!, note: null }, result)).toContain('gave nothing to go on')
  })

  test('support reads in calls and inputs', () => {
    const suggestion = {
      kind: 'ensures' as const,
      clause: 'result >= 0',
      template: 'sign' as never,
      pins: false,
      support: { calls: 1, inputs: 1 },
      example: { text: 'f(x = 1) returned 1', entry: 3 },
    }
    expect(supportText(suggestion)).toBe('held in 1 call with 1 different input')
    expect(supportText({ ...suggestion, support: { calls: 1200, inputs: 4 } })).toBe(
      'held in 1,200 calls with 4 different inputs',
    )
  })
})

describe('suggesting contracts in the studio', () => {
  test('the editor offers contracts for the fn under the cursor and adds the chosen clauses', async () => {
    const { store } = renderFresh(<ContractsCard />, DOUBLE)
    expect(screen.queryByRole('button', { name: /Suggest contracts/ })).toBeNull()

    act(() => setEditorCursorLine(1))
    fireEvent.click(screen.getByRole('button', { name: 'Suggest contracts for double' }))

    const card = screen.getByRole('region', { name: 'Contracts for double' })
    expect(card.textContent).toContain('Reading the recorded calls of double')
    await screen.findByText(/What every one of its 4 calls did, checked by recording/)
    const pin = screen.getByRole('checkbox', { name: 'ensures result == 2 * x' })
    expect((pin as HTMLInputElement).checked).toBe(true)
    const others = screen
      .getAllByRole('checkbox')
      .filter((box) => box !== pin) as HTMLInputElement[]
    for (const box of others) fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: 'Add to the function' }))

    const source = store.getState().source
    expect(source).toContain('ensures result == 2 * x')
    expect(source.match(/ensures|requires/g)?.length).toBe(1)
    expect(contractsTarget()).toBeNull()
  })

  test('an example call moves the pen to it; Escape closes the card', async () => {
    const { store, recording } = renderFresh(<ContractsCard />, DOUBLE)
    act(() => openContracts(functionAtLine(recording, 1)!))
    await screen.findByText(/What every one of its 4 calls did/)

    fireEvent.click(screen.getAllByRole('button', { name: /^double\(x = \d\) returned/ })[0]!)
    expect(recording.locationAt(store.getState().time)!.functionName).toBe('double')
    fireEvent.keyDown(screen.getByRole('region', { name: 'Contracts for double' }), {
      key: 'Escape',
    })

    expect(screen.queryByRole('region', { name: 'Contracts for double' })).toBeNull()
  })

  test('adding is held back while the program is being edited', async () => {
    const { store, recording } = renderFresh(<ContractsCard />, DOUBLE)
    act(() => openContracts(functionAtLine(recording, 1)!))
    await screen.findByText(/What every one of its 4 calls did/)

    act(() => store.setState({ source: `${DOUBLE}\n` }))

    const add = screen.getByRole('button', { name: 'Add to the function' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
  })

  test('a failed inference says why; the card closes from its button', async () => {
    setAnalysisService({ analyze: () => Promise.reject(new Error('the worker fell over')) })
    const { recording } = renderFresh(<ContractsCard />, DOUBLE)
    act(() => openContracts(functionAtLine(recording, 1)!))

    expect(await screen.findByText(/could not be inferred: the worker fell over/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close the contract suggestions' }))
    expect(contractsTarget()).toBeNull()
  })

  test('a card for another run is not shown', () => {
    const { recording } = renderFresh(<ContractsCard />, DOUBLE)
    const other = recordSource(DOUBLE)

    act(() => openContracts({ ...functionAtLine(recording, 1)!, recording: other }))

    expect(screen.queryByRole('region')).toBeNull()
  })

  test('the call stack offers contracts for a user frame', async () => {
    const recording = recordSource(DOUBLE)
    const inside = recording.lineHits(2)[0]!
    const { store } = renderWithRecording(<CallStack />, recording, inside)
    act(() => store.setState({ source: DOUBLE, recordedSource: DOUBLE }))

    fireEvent.click(screen.getByRole('button', { name: 'Suggest contracts for double' }))

    await waitFor(() => expect(contractsTarget()?.name).toBe('double'))
    expect(screen.getAllByRole('button', { name: /Suggest contracts/ }).length).toBe(1)
  })
})
