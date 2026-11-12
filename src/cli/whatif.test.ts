import { describe, expect, test } from 'vitest'
import { compile, record } from '../core/index'
import { parseArgs } from './args'
import { runCommand } from './commands'
import type { CliIO } from './io'
import { diffRows, visibleVariable } from './whatif'

const TOTALS = `var total = 0
for n in 1..=4 {
  total += n
}
print("start")
print("total = {total}")
print("done")
`

const LOCAL = `fn f(x) {
  var y = x
  print(y)
}
f(1)
`

function io(files: Record<string, string>) {
  const out: string[] = []
  const err: string[] = []
  const fake: CliIO = {
    color: false,
    readFile: (path) => {
      const content = files[path]
      if (content === undefined) throw new Error('no such file')
      return content
    },
    listFiles: () => [],
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }
  return { fake, out: () => out.join(''), err: () => err.join('') }
}

/** The step at which the `nth` run of the statement on `line` of `source` starts. */
function hit(source: string, line: number, nth: number): number {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('fixture does not compile')
  return record(compiled.program).lineHits(line)[nth]!
}

function whatif(source: string, ...args: string[]) {
  const parsed = parseArgs(['whatif', 'prog.sight', ...args])
  if (!parsed.ok) throw new Error(parsed.error)
  const streams = io({ 'prog.sight': source })
  const code = runCommand(parsed.command, streams.fake)
  return { code, out: streams.out(), err: streams.err() }
}

describe('hindsight whatif', () => {
  test('prints the edit, the divergence and the output diff', () => {
    const at = hit(TOTALS, 3, 2)
    const result = whatif(TOTALS, '--at', String(at), '--set', 'total=100')
    expect(result.code).toBe(0)
    expect(result.err).toBe('')
    expect(result.out).toContain(`what if total = 100 at step ${at} (it was 3)`)
    expect(result.out).toMatch(/the futures diverge at step [\d,]+ · line 3, column \d+ · in/)
    expect(result.out).toMatch(/real run: [\d,]+ steps, finishes normally/)
    expect(result.out).toContain(
      'output: 1 line only in the real run (-), 1 only in the what-if (+)',
    )
    expect(result.out).toContain(' start\n-total = 10\n+total = 107\n done\n')
  })

  test('says so when the futures do not diverge', () => {
    const at = hit(TOTALS, 3, 2)
    const result = whatif(TOTALS, `--at=${at}`, '--set=total=3')
    expect(result.code).toBe(0)
    expect(result.out).toContain('the futures do not diverge')
    expect(result.out).toContain('the output is the same')
  })

  test('names resolve to the innermost frame first', () => {
    const at = hit(LOCAL, 3, 0)
    const result = whatif(LOCAL, '--at', String(at), '--set', 'y="five"')
    expect(result.code).toBe(0)
    expect(result.out).toContain('what if y = "five"')
    expect(result.out).toContain('-1\n+five\n')
  })

  test('errors: a step past the end, an unknown name', () => {
    expect(whatif(TOTALS, '--at', '999999', '--set', 'total=1')).toMatchObject({ code: 1 })
    const unknown = whatif(TOTALS, '--at', '0', '--set', 'total=1')
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain("no variable named 'total' is visible at step 0")
  })
})

describe('whatif arguments', () => {
  test('parse into a command with a literal value', () => {
    expect(parseArgs(['whatif', 'a.sight', '--at', '5', '--set', 'n=-2.5'])).toEqual({
      ok: true,
      command: {
        kind: 'whatif',
        file: 'a.sight',
        at: 5,
        name: 'n',
        value: -2.5,
        values: [-2.5],
        maxSteps: 2_000_000,
        seed: 42,
      },
    })
  })

  test.each([
    [['whatif', 'a.sight', '--set', 'n=1'], "'whatif' needs --at T"],
    [['whatif', 'a.sight', '--at', '1'], "'whatif' needs --set NAME=VALUE"],
    [['whatif', 'a.sight', '--at', '1', '--set', '2=1'], "'whatif' needs --set NAME=VALUE"],
    [['whatif', 'a.sight', '--at', '1', '--set', 'n=abc'], '--set n: abc is a name'],
    [['whatif', 'a.sight', '--at', '-1', '--set', 'n=1'], "option '--at' must be an integer"],
    [['whatif', '--at', '1', '--set', 'n=1'], "'whatif' needs a FILE"],
    [['whatif', 'a.sight', '--at', '1', '--set', 'n=1', '--line', '2'], 'does not apply'],
    [['run', 'a.sight', '--set', 'n=1'], "option '--set' does not apply to 'run'"],
  ])('%j is a usage error', (argv, message) => {
    const parsed = parseArgs(argv)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain(message)
  })
})

describe('helpers', () => {
  test('long unchanged runs collapse to a count, keeping context around changes', () => {
    const same = (text: string) =>
      ({ kind: 'same', text, indexA: 0, indexB: 0, timeA: 0, timeB: 0 }) as const
    const added = {
      kind: 'added',
      text: '+',
      indexA: null,
      indexB: 0,
      timeA: null,
      timeB: 0,
    } as const
    const lines = [...'abcdefgh'].map(same)
    expect(diffRows(lines)).toEqual([8])
    const rows = diffRows([...lines, added, ...lines])
    expect(rows).toEqual([5, ...lines.slice(5), added, ...lines.slice(0, 3), 5])
  })

  test('visibleVariable prefers locals, then captures, then globals', () => {
    const value = { kind: 'nil' } as const
    const target = (slot: number) => ({ kind: 'local', frameUid: 1, slot }) as const
    const view = {
      frames: [
        {
          locals: [
            { name: 'a', target: target(1), value },
            { name: 'a', target: target(2), value },
          ],
          captures: [{ name: 'b', target: { kind: 'cell', cellId: 5 }, value }],
        },
      ],
      globals: [
        { name: 'b', target: { kind: 'global', name: 'b' }, value },
        { name: 'c', target: { kind: 'global', name: 'c' }, value },
      ],
    } as unknown as Parameters<typeof visibleVariable>[0]
    expect(visibleVariable(view, 'a')?.target).toEqual(target(2))
    expect(visibleVariable(view, 'b')?.target).toEqual({ kind: 'cell', cellId: 5 })
    expect(visibleVariable(view, 'c')?.target).toEqual({ kind: 'global', name: 'c' })
    expect(visibleVariable(view, 'd')).toBeNull()
  })
})
