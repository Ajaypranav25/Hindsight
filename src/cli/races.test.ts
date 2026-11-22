import { describe, expect, test } from 'vitest'
import { DEFAULT_MAX_STEPS, DEFAULT_SEED } from '../core/api-types'
import { BANK_RACE } from '../core/testing/tasks'
import { parseArgs } from './args'
import type { CliIO } from './io'
import { main } from './main'

interface FakeIO extends CliIO {
  readonly out: string[]
  readonly err: string[]
}

function fakeIO(files: Record<string, string>): FakeIO {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    color: false,
    readFile(path) {
      const content = files[path]
      if (content === undefined) throw new Error('no such file')
      return content
    },
    listFiles: () => [],
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }
}

const STUCK = `let ch = channel()
fn worker() {
  print(recv(ch))
}
spawn(worker)
yield()
print("main done")`

describe('schedule options', () => {
  test('run, replay and record take a random schedule', () => {
    // Arrange, Act
    const parsed = parseArgs([
      'run',
      'a.sight',
      '--schedule',
      'random',
      '--schedule-seed=4',
      '--quantum',
      '3',
    ])
    const replay = parseArgs(['replay', 'a.sight', '--at', '5', '--schedule', 'random'])

    // Assert
    expect(parsed).toEqual({
      ok: true,
      command: {
        kind: 'run',
        file: 'a.sight',
        maxSteps: DEFAULT_MAX_STEPS,
        seed: DEFAULT_SEED,
        schedule: { policy: 'random', quantum: 3, seed: 4 },
      },
    })
    expect(replay).toMatchObject({
      ok: true,
      command: { schedule: { policy: 'random', quantum: 10, seed: 1 } },
    })
    expect(parseArgs(['record', 'a.sight', '--schedule', 'round-robin'])).toMatchObject({
      ok: true,
      command: { kind: 'record', schedule: undefined },
    })
  })

  test('schedule options are checked', () => {
    // Arrange, Act, Assert
    expect(parseArgs(['run', 'a.sight', '--schedule', 'fair'])).toEqual({
      ok: false,
      error: "--schedule must be 'round-robin' or 'random'",
    })
    expect(parseArgs(['run', 'a.sight', '--quantum', '3'])).toEqual({
      ok: false,
      error: "option '--quantum' needs --schedule random",
    })
    expect(parseArgs(['run', 'a.sight', '--schedule', 'random', '--quantum', '0'])).toMatchObject({
      ok: false,
    })
    expect(
      parseArgs(['run', 'a.sight', '--schedule', 'random', '--schedule-seed', 'x']),
    ).toMatchObject({ ok: false })
    expect(parseArgs(['run', 'a.sighttrace', '--schedule', 'random'])).toEqual({
      ok: false,
      error: 'a trace file brings its own step limit, seed and schedule: drop --schedule',
    })
    expect(parseArgs(['why', 'a.sight', '--schedule', 'random'])).toEqual({
      ok: false,
      error: "option '--schedule' does not apply to 'why'",
    })
  })

  test('races takes runs, a first seed and a quantum', () => {
    // Arrange, Act, Assert
    expect(parseArgs(['races', 'a.sight'])).toEqual({
      ok: true,
      command: {
        kind: 'races',
        file: 'a.sight',
        runs: 20,
        seed: 1,
        quantum: 10,
        maxSteps: DEFAULT_MAX_STEPS,
      },
    })
    expect(
      parseArgs(['races', 'a.sight', '--runs', '5', '--seed', '9', '--quantum', '2']),
    ).toMatchObject({ ok: true, command: { runs: 5, seed: 9, quantum: 2 } })
    expect(parseArgs(['races', 'a.sight', '--runs', '1'])).toMatchObject({ ok: false })
    expect(parseArgs(['races', 'a.sight', '--runs', '501'])).toEqual({
      ok: false,
      error: "option '--runs' must be at most 500",
    })
    expect(parseArgs(['races', 'a.sight', '--seed', '-1'])).toMatchObject({ ok: false })
    expect(parseArgs(['races', 'a.sight', '--quantum', '0'])).toMatchObject({ ok: false })
    expect(parseArgs(['races'])).toEqual({ ok: false, error: "'races' needs a FILE" })
  })
})

describe('hindsight races', () => {
  test('reports the lost update and exits 1 when results differ', () => {
    // Arrange
    const io = fakeIO({ 'bank.sight': BANK_RACE })

    // Act
    const code = main(['races', 'bank.sight', '--runs', '12', '--quantum', '4'], io)

    // Assert
    const text = io.out.join('')
    expect(code).toBe(1)
    expect(text).toMatch(/^12 schedules \(random, quantum 4\): \d+ different results/)
    expect(text).toContain('race candidates (written by more than one task before that):')
    expect(text).toMatch(/balance {2}task 2 \(deposit\) 30×, task 3 \(deposit\) 30× · line 6/)
    expect(text).toMatch(
      /replay: hindsight replay bank\.sight --schedule random --schedule-seed \d+ --quantum 4 --at \d+/,
    )
  })

  test('exits 0 when every schedule does the same', () => {
    // Arrange
    const io = fakeIO({
      'pair.sight': 'let ch = channel()\nspawn(fn() { send(ch, 1) })\nprint(recv(ch))',
    })

    // Act
    const code = main(['races', 'pair.sight', '--runs', '3'], io)

    // Assert
    expect(code).toBe(0)
    expect(io.out.join('')).toContain('every schedule gave the same result')
  })

  test('says when a program never starts a task, and fails on compile errors', () => {
    // Arrange
    const io = fakeIO({ 'plain.sight': 'print(1)', 'bad.sight': 'print(' })

    // Act
    const plain = main(['races', 'plain.sight', '--runs', '2'], io)
    const bad = main(['races', 'bad.sight'], io)

    // Assert
    expect(plain).toBe(0)
    expect(io.out.join('')).toContain('never started a task')
    expect(bad).toBe(2)
  })

  test('shows a failing group’s outcome', () => {
    // Arrange
    const source = `var log = []
fn add(v) {
  yield()
  push(log, v)
}
let a = spawn(add, 1)
let b = spawn(add, 2)
wait(a)
wait(b)
assert(log[0] == 1)`
    const io = fakeIO({ 'order.sight': source })

    // Act
    const code = main(['races', 'order.sight', '--runs', '30', '--quantum', '2'], io)

    // Assert
    expect(code).toBe(1)
    expect(io.out.join('')).toContain('printed nothing, ends with R018: assertion failed')
    expect(io.out.join('')).toContain('their outcomes differ')
  })
})

describe('run and replay with tasks', () => {
  test('run notes the tasks left waiting when the main task ends', () => {
    // Arrange
    const io = fakeIO({ 'stuck.sight': STUCK })

    // Act
    const code = main(['run', 'stuck.sight'], io)

    // Assert
    expect(code).toBe(0)
    expect(io.out.join('')).toBe('main done\n')
    expect(io.err.join('')).toContain(
      'note: the main task ended while 1 task was unfinished: task 2 (worker) waits to receive from channel #',
    )
  })

  test('run under a random schedule is reproducible', () => {
    // Arrange
    const first = fakeIO({ 'bank.sight': BANK_RACE })
    const second = fakeIO({ 'bank.sight': BANK_RACE })
    const args = [
      'run',
      'bank.sight',
      '--schedule',
      'random',
      '--schedule-seed',
      '3',
      '--quantum',
      '4',
    ]

    // Act
    main(args, first)
    main(args, second)

    // Assert
    expect(first.out).toEqual(second.out)
  })

  test('replay lists every task with its status', () => {
    // Arrange
    const io = fakeIO({ 'stuck.sight': STUCK })

    // Act
    const code = main(['replay', 'stuck.sight', '--at', '100000'], io)

    // Assert
    const text = io.out.join('')
    expect(code).toBe(0)
    expect(text).toContain('tasks:\n  ▶ task 1 main: done, returned nil\n')
    expect(text).toMatch(/task 2 worker: waits to receive from channel #\d+ \(worker, line 3\)/)
  })

  test('a deadlock explains every wait', () => {
    // Arrange
    const io = fakeIO({
      'dead.sight': 'let ch = channel()\nfn w() { recv(ch) }\nlet t = spawn(w)\nwait(t)',
    })

    // Act
    const code = main(['run', 'dead.sight'], io)

    // Assert
    expect(code).toBe(1)
    expect(io.err.join('')).toContain('R028')
    expect(io.err.join('')).toContain('deadlock: every task is waiting')
    expect(io.err.join('')).toMatch(/task 1 \(main\) waits for task 2 \(w\)/)
  })
})
