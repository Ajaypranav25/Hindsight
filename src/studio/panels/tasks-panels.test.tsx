// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { compile, record, type Recording, type TaskView } from '../../core/index'
import { Settings } from '../chrome/Settings'
import { DEFAULT_SETTINGS, scheduleOptions, storedSettings } from '../state/defaults'
import { CallStack } from './CallStack'
import { Console } from './Console'
import { statusText } from './TaskList'
import { renderWithRecording } from './test-fixtures'

afterEach(cleanup)

function recorded(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('does not compile')
  return record(compiled.program)
}

const HANDOFF = `let ch = channel()
fn producer(n) {
  for i in 0..n {
    send(ch, i)
  }
  return "done"
}
let p = spawn(producer, 2)
print(recv(ch) + recv(ch), wait(p))`

const STUCK = `let ch = channel()
fn worker() {
  print(recv(ch))
}
spawn(worker)
yield()
print("main done")`

const DEADLOCK = `let ch = channel()
fn w() {
  recv(ch)
}
let t = spawn(w)
wait(t)`

describe('the call stack with tasks', () => {
  test('lists every task with what it is doing under the running task’s frames', () => {
    // Arrange
    const recording = recorded(HANDOFF)
    let time = 0
    while (recording.stateAt(time).tasks?.[0]?.status !== 'blocked') time++

    // Act
    renderWithRecording(<CallStack />, recording, time)

    // Assert
    const tasks = within(screen.getByRole('region', { name: 'Tasks' }))
    const rows = tasks.getAllByRole('listitem').map((row) => row.textContent)
    expect(rows[0]).toMatch(/^1main.*waits to receive from channel #\d+<top level> · line 9$/)
    expect(rows[1]).toBe('2producerrunning')
    // The selected frame also offers Suggest contracts (its "Contracts" button).
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      expect.stringMatching(/^producerline [34]/),
      'Contracts',
    ])
  })

  test('a finished run still lists the tasks left waiting', () => {
    // Arrange
    const recording = recorded(STUCK)

    // Act
    renderWithRecording(<CallStack />, recording, recording.length)

    // Assert
    expect(screen.getByText('Program finished')).toBeTruthy()
    const tasks = within(screen.getByRole('region', { name: 'Tasks' }))
    expect(tasks.getByText('done')).toBeTruthy()
    expect(tasks.getByText(/waits to receive from channel/)).toBeTruthy()
  })

  test('a program without tasks shows no task list', () => {
    // Arrange, Act
    const recording = recorded('fn f() { 1 }\nprint(f())')
    renderWithRecording(<CallStack />, recording, 3)

    // Assert
    expect(screen.queryByRole('region', { name: 'Tasks' })).toBeNull()
  })

  test('status texts cover ready, done with a result, and joins by name', () => {
    // Arrange
    const base: TaskView = {
      id: 2,
      name: 'w',
      status: 'runnable',
      current: false,
      wait: null,
      frames: [],
      result: null,
    }

    // Act, Assert
    expect(statusText(base, () => undefined)).toBe('ready')
    expect(statusText({ ...base, status: 'done' }, () => undefined)).toBe('done')
    expect(
      statusText(
        { ...base, status: 'done', result: { kind: 'number', value: 4 } },
        () => undefined,
      ),
    ).toBe('done · returned 4')
    expect(
      statusText({ ...base, status: 'blocked', wait: { kind: 'join', task: 3 } }, () => 'feed'),
    ).toBe('waits for task 3 (feed)')
    expect(
      statusText({ ...base, status: 'blocked', wait: { kind: 'send', channelId: 9 } }, () => 'x'),
    ).toBe('waits to send to channel #9')
  })
})

describe('the console with tasks', () => {
  test('a deadlock lists what every task waits for', () => {
    // Arrange
    const recording = recorded(DEADLOCK)

    // Act
    renderWithRecording(<Console />, recording, recording.length)

    // Assert
    const waits = within(screen.getByRole('list', { name: 'What each task waits for' }))
    expect(waits.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^task 2 \(w\) waits to receive from channel #\d+ here$/),
      'task 1 (main) waits for task 2 (w) on line 6',
    ])
    expect(screen.getByText(/deadlock: every task is waiting/)).toBeTruthy()
  })

  test('a finished run names the tasks the main task left unfinished', () => {
    // Arrange
    const recording = recorded(STUCK)

    // Act
    renderWithRecording(<Console />, recording, recording.length)

    // Assert
    const note = screen.getByRole('note')
    expect(note.textContent).toMatch(
      /^The main task ended while 1 task was unfinished:task 2 \(worker\) waits to receive from channel #\d+$/,
    )
  })
})

describe('the schedule setting', () => {
  test('switches to random, changes the seed and quantum, and moves to the next seed', () => {
    // Arrange
    const { store } = renderWithRecording(<Settings />, null)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    // Act
    fireEvent.click(screen.getByRole('radio', { name: 'Random' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Seed' }), { target: { value: '7' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantum' }), {
      target: { value: '3' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next seed' }))

    // Assert
    expect(store.getState().settings.schedule).toEqual({ policy: 'random', seed: 8, quantum: 3 })
    expect(scheduleOptions(store.getState().settings.schedule)).toEqual({
      policy: 'random',
      seed: 8,
      quantum: 3,
    })
    act(() => fireEvent.click(screen.getByRole('radio', { name: 'Round-robin' })))
    expect(scheduleOptions(store.getState().settings.schedule)).toBeUndefined()
    expect(screen.queryByRole('spinbutton', { name: 'Seed' })).toBeNull()
  })

  test('bad numbers keep the previous value', () => {
    // Arrange
    const { store } = renderWithRecording(<Settings />, null)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Random' }))

    // Act
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Seed' }), { target: { value: 'x' } })

    // Assert
    expect(store.getState().settings.schedule.seed).toBe(DEFAULT_SETTINGS.schedule.seed)
  })

  test('stored settings from before schedules keep their other fields', () => {
    // Arrange
    const { schedule: _schedule, ...older } = { ...DEFAULT_SETTINGS, maxSteps: 500_000 }

    // Act
    const loaded = storedSettings(older)

    // Assert
    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, maxSteps: 500_000 })
    expect(storedSettings({ ...older, schedule: { policy: 'fair', seed: 1, quantum: 1 } })).toBe(
      null,
    )
    expect(storedSettings(null)).toBeNull()
  })
})
