import { describe, expect, test } from 'vitest'
import { DEFAULT_MAX_STEPS, DEFAULT_SEED } from '../core/api-types'
import type { Strategy } from '../core/index'
import { parseArgs, USAGE } from './args'
import { type DebugSession, openDebugSession, parseAnswer } from './debug'
import type { CliIO } from './io'

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

const AVERAGE = `fn total(xs) {
  var sum = 0
  for x in xs {
    sum += x
  }
  sum
}
fn average(xs) {
  total(xs) / (len(xs) - 1)
}
print(average([88, 83, 79]))
`

interface OpenOptions {
  readonly strategy?: Strategy
  readonly maxSteps?: number
  readonly auto?: boolean
  readonly ask?: boolean
}

function open(source: string, options: OpenOptions = {}): { io: FakeIO; session: DebugSession } {
  const io = fakeIO({ 'avg.sight': source })
  const session = openDebugSession(io, {
    kind: 'debug',
    file: 'avg.sight',
    strategy: options.strategy ?? 'top-down',
    auto: options.auto ?? true,
    ask: options.ask ?? true,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    seed: 1,
  })
  if (typeof session === 'number') throw new Error(`no session: ${io.err.join('')}`)
  return { io, session }
}

/** Feeds answers line by line, as a pipe would. */
function feed(session: DebugSession, lines: readonly string[]): void {
  for (const line of lines) if (!session.handle(line)) return
}

describe('debug arguments', () => {
  test('parses debug with its options and rejects others', () => {
    expect(parseArgs(['debug', 'a.sight'])).toEqual({
      ok: true,
      command: {
        kind: 'debug',
        file: 'a.sight',
        strategy: 'divide',
        auto: true,
        ask: true,
        maxSteps: DEFAULT_MAX_STEPS,
        seed: DEFAULT_SEED,
      },
    })
    expect(parseArgs(['debug', 'a.sight', '--no-auto', '--no-ask'])).toMatchObject({
      ok: true,
      command: { auto: false, ask: false },
    })
    expect(parseArgs(['debug', 'a.sight', '--no-ask=1'])).toMatchObject({ ok: false })
    expect(parseArgs(['debug', 'a.sight', '--max-steps=50', '--seed', '3'])).toMatchObject({
      ok: true,
      command: { maxSteps: 50, seed: 3 },
    })
    expect(parseArgs(['debug'])).toEqual({ ok: false, error: "'debug' needs a FILE" })
    expect(parseArgs(['debug', 'a.sight', '--at', '3'])).toEqual({
      ok: false,
      error: "option '--at' does not apply to 'debug'",
    })
    expect(parseArgs(['debug', 'a.sight', 'b.sight'])).toEqual({
      ok: false,
      error: "unexpected argument 'b.sight'",
    })
    expect(USAGE).toContain('hindsight debug FILE [--max-steps N] [--seed S]')
    expect(USAGE).toContain('[--no-auto] [--no-ask]')
  })

  test('reads answers in short and long forms', () => {
    const inputs = ['r', 'Right', ' w ', 'wrong', '?', 'n', 'not sure', 'u', 'undo', 'q', 'x', '']
    expect(inputs.map(parseAnswer)).toEqual([
      'right',
      'right',
      'wrong',
      'wrong',
      'unsure',
      'unsure',
      'unsure',
      'undo',
      'undo',
      'quit',
      null,
      null,
    ])
  })
})

describe('the debug interview', () => {
  test('asks about calls and ends with the verdict and a code frame of the function', () => {
    const { io, session } = open(AVERAGE)
    expect(io.out.join('')).toContain('Question 1: average(xs = [88, 83, 79]) returned 125\n')
    feed(session, ['w', 'r'])
    const out = io.out.join('')
    expect(out).toContain('Question 2: total(xs = [88, 83, 79]) returned 250\n')
    expect(out).toContain('Found it: the bug is in average (lines 8–10).\n')
    expect(out).toContain(
      'Every call it makes returned the right value, but its own result is wrong.',
    )
    expect(out).toContain('   9 |   total(xs) / (len(xs) - 1)\n')
    expect(session.finished).toBe(true)
    expect(session.exitCode).toBe(0)
  })

  test('undo, not sure and unknown answers', () => {
    const { io, session } = open(AVERAGE)
    feed(session, ['w', 'u', 'maybe', 'w', '?'])
    const out = io.out.join('')
    expect(out).toContain('(took back the answer about average)')
    expect(out).toContain(
      'Please answer r (right), w (wrong), n or ? (not sure), u (undo) or q (quit).',
    )
    expect(out).toContain('Probably: the bug is in average (lines 8–10).')
    expect(session.exitCode).toBe(0)
  })

  test('undo at the first question says there is nothing to take back', () => {
    const { io, session } = open(AVERAGE)
    feed(session, ['u'])
    expect(io.out.join('')).toContain('(nothing to take back)')
    expect(session.finished).toBe(false)
  })

  test('quitting or running out of input ends without a verdict', () => {
    const quit = open(AVERAGE)
    feed(quit.session, ['q'])
    expect(quit.session.finished).toBe(true)
    expect(quit.session.exitCode).toBe(1)
    const ended = open(AVERAGE)
    ended.session.end()
    expect(ended.io.err.join('')).toContain('stopped before a verdict')
    expect(ended.session.exitCode).toBe(1)
    const done = open(AVERAGE)
    feed(done.session, ['w', 'r'])
    done.session.end()
    expect(done.io.err.join('')).toBe('')
    expect(done.session.handle('w')).toBe(false)
  })

  test('a program without calls has its verdict at once', () => {
    const { io, session } = open('let x = 1 + 1\nprint(x)\n')
    expect(session.finished).toBe(true)
    expect(io.out.join('')).toContain('Found it: the bug is in the top-level code (lines 1–2).')
    expect(io.out.join('')).toContain('   1 | let x = 1 + 1\n')
  })

  test('a failed run is explained first; questions follow', () => {
    const { io, session } = open('fn get(xs) {\n  xs[3]\n}\nprint(get([1]))\n')
    expect(io.err.join('')).toMatch(/runtime error\[R\d{3}\]/)
    expect(io.out.join('')).toContain('The bug finder is for wrong results')
    expect(io.out.join('')).toMatch(/Question 1: get\(xs = \[1\]\) raised an error: .+\n/)
    feed(session, ['w'])
    expect(io.out.join('')).toContain(
      'It makes no calls of its own, and it raised an error itself.',
    )
  })

  test('a run cut off by the step limit says so', () => {
    const { io } = open('fn spin() {\n  while true {}\n}\nspin()\n', { maxSteps: 100 })
    expect(io.out.join('')).toContain('stopped at the step limit')
    expect(io.out.join('')).toContain(
      'Question 1: spin() was still running when the recording stopped',
    )
  })

  test('long functions are cut in the code frame', () => {
    const body = Array.from({ length: 40 }, (_, i) => `  let v${i} = ${i}`).join('\n')
    const { io, session } = open(`fn long() {\n${body}\n  0\n}\nlong()\n`)
    expect(io.out.join('')).toContain('Question 1: long() returned 0')
    feed(session, ['w'])
    const out = io.out.join('')
    expect(out).toContain('Found it: the bug is in long (lines 1–43).')
    expect(out).toContain('  14 |   let v12 = 12\n')
    expect(out).toContain('… 29 more lines')
    expect(out).not.toContain('let v13 = 13')
  })

  test('a file that does not compile is reported with exit code 1', () => {
    const io = fakeIO({ 'bad.sight': 'let = 1\n' })
    const result = openDebugSession(io, {
      kind: 'debug',
      file: 'bad.sight',
      strategy: 'top-down',
      auto: true,
      ask: true,
      maxSteps: 10,
      seed: 1,
    })
    expect(result).toBe(1)
    expect(io.err.join('')).toContain('error[')
  })

  test('program text is sanitized for the terminal', () => {
    const { io } = open('fn shout(s) {\n  s\n}\nshout("\\u{1b}[2J")\n')
    expect(io.out.join('')).not.toContain('\u001b')
  })
})

const CONTRACTS = `fn total(xs) {
  var sum = 0
  for x in xs {
    sum += x
  }
  sum
}
fn average(xs)
  ensures result * len(xs) == total(xs)
{
  total(xs) / (len(xs) - 1)
}
assert(total([88, 83, 79]) == 250)
print(average([88, 83, 79]))
`

/** CONTRACTS without its assertion: the postcondition answers the first question only. */
const POSTCONDITION_ONLY = CONTRACTS.replace('assert(total([88, 83, 79]) == 250)\n', '')

describe('automatic answers from contracts and assertions', () => {
  test('answers every question itself and prints each answer with its evidence', () => {
    // Arrange / Act
    const { io, session } = open(CONTRACTS)
    const divided = open(CONTRACTS, { strategy: 'divide' })

    // Assert
    const out = io.out.join('')
    expect(out).toContain('The run failed a contract or an assertion (above)')
    expect(out).toContain(
      'Question 1: total(xs = [88, 83, 79]) returned 250 — right (the assertion on line 13)\n',
    )
    expect(out).toContain(
      'Question 2: average(xs = [88, 83, 79]) raised an error: postcondition failed: ' +
        'result * len(xs) == total(xs) (R027) — wrong (its postcondition on line 9 failed)\n',
    )
    expect(out).toContain('Found it: the bug is in average (lines 8–12).')
    expect(out).not.toContain('Is that right?')
    expect(session.finished).toBe(true)
    expect(session.exitCode).toBe(0)
    expect(divided.io.out.join('')).toContain(
      'Question 2: total(xs = [88, 83, 79]) returned 250 — right ' +
        '(an identical call passed the assertion on line 13)\n',
    )
    expect(divided.session.exitCode).toBe(0)
  })

  test('asks a person the questions contracts cannot answer, numbering on', () => {
    // Arrange / Act
    const { io, session } = open(POSTCONDITION_ONLY)
    feed(session, ['r'])

    // Assert
    const out = io.out.join('')
    expect(out).toContain('— wrong (its postcondition on line 9 failed)')
    expect(out).toContain('Question 2: total(xs = [88, 83, 79]) returned 250\n')
    expect(out).toContain('Found it: the bug is in average')
    expect(session.exitCode).toBe(0)
  })

  test('--no-auto leaves every question to the person', () => {
    // Arrange / Act
    const { io, session } = open(CONTRACTS, { auto: false })

    // Assert
    const out = io.out.join('')
    expect(out).toContain('Question 1: total(xs = [88, 83, 79]) returned 250\n')
    expect(out).not.toContain('— right')
    expect(session.finished).toBe(false)
  })

  test('undo takes back an automatic answer and hands that question to the person', () => {
    // Arrange
    const { io, session } = open(POSTCONDITION_ONLY)

    // Act
    feed(session, ['u', 'w', 'r'])

    // Assert
    const out = io.out.join('')
    expect(out).toContain('(took back the automatic answer about average; it is yours to answer)')
    expect(out).toMatch(
      /answer\)\n\nQuestion 1: average\(xs = \[88, 83, 79\]\) raised an error: .+\(R027\)\n/,
    )
    expect(out).toContain('Found it: the bug is in average')
    expect(session.exitCode).toBe(0)
  })

  test('--no-ask stops at the first question nobody can answer, with exit code 3', () => {
    // Arrange / Act
    const { io, session } = open(POSTCONDITION_ONLY, { ask: false })

    // Assert
    const out = io.out.join('')
    expect(out).toContain('Question 2: total(xs = [88, 83, 79]) returned 250\n')
    expect(out).toContain(
      'stopped: no contract or assertion answers this question, and --no-ask means nobody else is asked.',
    )
    expect(out).not.toContain('Is that right?')
    expect(session.finished).toBe(true)
    expect(session.exitCode).toBe(3)
    expect(session.handle('r')).toBe(false)
  })

  test('--no-ask still reaches the verdict when contracts answer everything', () => {
    // Arrange / Act
    const { session } = open(CONTRACTS, { ask: false })

    // Assert
    expect(session.finished).toBe(true)
    expect(session.exitCode).toBe(0)
  })
})
