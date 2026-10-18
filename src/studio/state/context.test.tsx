// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { memoryStorage } from '../lib/storage'
import { StudioProvider, useStateView, useStudio, useStudioActions } from './context'
import { ManualScheduler } from './scheduler'
import { createStudioStore } from './store'
import { fakeRecording, scriptedEngine } from './testing'

function Probe() {
  const time = useStudio((s) => s.time)
  const view = useStateView()
  const { seek } = useStudioActions()
  return (
    <button type="button" onClick={() => seek(time + 1)}>
      time {time} view {view ? view.time : 'none'}
    </button>
  )
}

describe('studio context', () => {
  test('components read state and call actions through the provider', async () => {
    const engine = scriptedEngine()
    const store = createStudioStore(
      { engine, storage: memoryStorage(), scheduler: new ManualScheduler(), examples: [] },
      { sharedSource: 'print(1)' },
    )
    render(
      <StudioProvider store={store}>
        <Probe />
      </StudioProvider>,
    )
    expect(screen.getByRole('button').textContent).toBe('time 0 view none')
    await act(async () => {
      void store.getState().run()
      await engine.resolveNext(fakeRecording({ length: 5 }))
    })
    act(() => screen.getByRole('button').click())
    expect(screen.getByRole('button').textContent).toBe('time 5 view 5')
  })

  test('hooks outside a provider fail with a clear message', () => {
    expect(() => render(<Probe />)).toThrow(/StudioProvider/)
  })
})
