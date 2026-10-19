// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Location, Recording } from '../../core/api-types'
import { memoryStorage } from '../lib/storage'
import { StudioProvider } from '../state/context'
import { ManualScheduler } from '../state/scheduler'
import { createStudioStore } from '../state/store'
import { fakeRecording, scriptedEngine } from '../state/testing'
import { StripChart } from './StripChart'
import { TapeCounter } from './TapeCounter'
import { Transport } from './Transport'

afterEach(cleanup)

const location: Location = {
  protoId: 1,
  ip: 3,
  depth: 2,
  functionName: 'fib',
  source: 'main',
  library: false,
  span: { start: 0, end: 1 },
  stmtSpan: { start: 0, end: 1 },
  line: 7,
  stmtLine: 7,
  stmtStart: true,
  opName: 'Add',
}

function recordingWithLocations(length: number): Recording {
  const base = fakeRecording({ length })
  return { ...base, locationAt: (t: number) => (t < length ? location : null) }
}

async function setup(recording: Recording | null) {
  const engine = scriptedEngine()
  const store = createStudioStore(
    { engine, storage: memoryStorage(), scheduler: new ManualScheduler(), examples: [] },
    { sharedSource: 'print(1)' },
  )
  if (recording) {
    await act(async () => {
      void store.getState().run()
      await engine.resolveNext(recording)
    })
  }
  const spies = {
    jumpToStart: vi.fn(),
    jumpToEnd: vi.fn(),
    stepNav: vi.fn(),
    continueNav: vi.fn(),
    togglePlay: vi.fn(),
    stopPlay: vi.fn(),
    stepInstruction: vi.fn(),
    updateSettings: vi.fn(),
  }
  store.setState(spies)
  const ui = (
    <StudioProvider store={store}>
      <Transport />
      <TapeCounter />
      <StripChart />
    </StudioProvider>
  )
  render(ui)
  return { store, spies }
}

describe('Transport', () => {
  test('every button calls its action', async () => {
    const { spies } = await setup(recordingWithLocations(56_789))
    const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
    click('Jump to start')
    click('Continue backward to the previous breakpoint')
    click('Step back over')
    click('Step back into')
    click('Play')
    click('Step into')
    click('Step over')
    click('Step out')
    click('Continue to the next breakpoint')
    click('Jump to end')
    expect(spies.jumpToStart).toHaveBeenCalledTimes(1)
    expect(spies.jumpToEnd).toHaveBeenCalledTimes(1)
    expect(spies.togglePlay).toHaveBeenCalledTimes(1)
    expect(spies.continueNav.mock.calls).toEqual([['backward'], ['forward']])
    expect(spies.stepNav.mock.calls).toEqual([
      ['over', 'backward'],
      ['into', 'backward'],
      ['into', 'forward'],
      ['over', 'forward'],
      ['out', 'forward'],
    ])
  })

  test('buttons appear in transport order with shortcuts in their titles', async () => {
    await setup(recordingWithLocations(10))
    const toolbar = screen.getByRole('toolbar', { name: 'Time travel' })
    const labels = [...toolbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual([
      'Jump to start',
      'Continue backward to the previous breakpoint',
      'Step back over',
      'Step back into',
      'Play',
      'Step into',
      'Step over',
      'Step out',
      'Continue to the next breakpoint',
      'Jump to end',
    ])
    expect(screen.getByRole('button', { name: 'Step into' }).title).toBe('Step into (F11)')
    expect(screen.getByRole('button', { name: 'Step back over' }).title).toContain('Shift+F10')
  })

  test('everything is disabled without a recording', async () => {
    await setup(null)
    for (const button of screen.getAllByRole('button'))
      expect(button).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Speed')).toHaveProperty('disabled', true)
  })

  test('instruction level adds single-instruction buttons and the op name', async () => {
    const { store, spies } = await setup(recordingWithLocations(10))
    act(() =>
      store.setState({ settings: { ...store.getState().settings, instructionLevel: true } }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back one instruction' }))
    fireEvent.click(screen.getByRole('button', { name: 'Forward one instruction' }))
    expect(spies.stepInstruction.mock.calls).toEqual([['backward'], ['forward']])
    act(() => store.setState({ time: 4 }))
    expect(screen.getByLabelText('Current instruction').textContent).toContain('Add')
  })

  test('changing speed while playing restarts playback at the new speed', async () => {
    const { store, spies } = await setup(recordingWithLocations(10))
    act(() => store.setState({ playing: true }))
    expect(screen.getByRole('button', { name: 'Pause' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '30' } })
    expect(spies.updateSettings).toHaveBeenCalledWith({ playbackSpeed: 30 })
    expect(spies.stopPlay).toHaveBeenCalledTimes(1)
    expect(spies.togglePlay).toHaveBeenCalledTimes(1)
  })
})

describe('TapeCounter', () => {
  test('shows the step, total, line, function and depth', async () => {
    const { store } = await setup(recordingWithLocations(56_789))
    act(() => store.setState({ time: 1234 }))
    const group = screen.getByRole('group', { name: 'Step 1,234 of 56,789' })
    expect(group.textContent).toContain('0 001 234/0 056 789')
    expect(group.textContent).toContain('line 7 · fib · depth 2')
  })

  test('shows the end of a finished run and the idle state', async () => {
    const { store } = await setup(recordingWithLocations(20))
    act(() => store.setState({ time: 20 }))
    expect(screen.getByRole('group').textContent).toContain('finished')
    cleanup()
    await setup(null)
    expect(screen.getByRole('group', { name: 'No recording yet' }).textContent).toContain(
      '0 000 000/0 000 000',
    )
  })
})

describe('StripChart', () => {
  test('is a keyboard slider over the recording', async () => {
    const { store, spies } = await setup(recordingWithLocations(56_789))
    act(() => store.setState({ time: 1234 }))
    const slider = screen.getByRole('slider', { name: 'Time' })
    expect(slider.getAttribute('aria-valuemax')).toBe('56789')
    expect(slider.getAttribute('aria-valuenow')).toBe('1234')
    expect(slider.getAttribute('aria-valuetext')).toBe('step 1,234 of 56,789, line 7')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(slider, { key: 'Home' })
    fireEvent.keyDown(slider, { key: 'End' })
    expect(spies.stepNav.mock.calls).toEqual([
      ['into', 'forward'],
      ['over', 'backward'],
    ])
    expect(spies.jumpToStart).toHaveBeenCalledTimes(1)
    expect(spies.jumpToEnd).toHaveBeenCalledTimes(1)
  })

  test('shows an empty state without a recording', async () => {
    await setup(null)
    expect(screen.getByRole('slider').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('Run a program to trace its call depth here')).toBeTruthy()
  })
})
