import { describe, expect, test } from 'vitest'
import { parseArgs } from './args'
import type { CliIO } from './io'
import { main } from './main'

function cli(args: string[], files: Record<string, string>, color = false) {
  const out: string[] = []
  const err: string[] = []
  const io: CliIO = {
    color,
    readFile(path) {
      const content = files[path]
      if (content === undefined) throw new Error('no such file')
      return content
    },
    listFiles: () => [],
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }
  const code = main(args, io)
  return { code, out: out.join(''), err: err.join('') }
}

const AVERAGE =
  'fn total(scores) {\n  var sum = 0\n  for s in scores { sum += s }\n  sum\n}\n' +
  'fn average(scores) {\n  total(scores) / (len(scores) + 1)\n}\n' +
  'let scores = [92, 88, 95]\nprint(average(scores))\n'
const FIXED = AVERAGE.replace('len(scores) + 1', 'len(scores)')
const FILES = { 'a.sight': AVERAGE, 'b.sight': FIXED }

describe('hindsight diff A B', () => {
  test('two versions that behave differently: the output diff and the origin, exit 1', () => {
    // Act
    const { code, out } = cli(['diff', 'a.sight', 'b.sight'], FILES)

    // Assert
    expect(code).toBe(1)
    expect(out).toContain('diff A = a.sight, B = b.sight')
    expect(out).toMatch(/A: \d+ steps, finishes normally, 3 calls/)
    expect(out).toContain('output: 1 line only in A (-), 1 only in B (+)')
    expect(out).toContain('-68.75\n+91.66666666666667')
    expect(out).toContain('changed calls (2):')
    expect(out).toContain('the change starts in:')
    expect(out).toContain(
      '✓ average (lines 6–8): given the same inputs, it behaves differently while the calls it makes behave the same',
    )
    expect(out).toMatch(/- average\(scores = \[92, 88, 95\]\) returned 68\.75 {2}step \d+/)
  })

  test('the same program twice behaves the same: exit 0', () => {
    const { code, out } = cli(['diff', 'a.sight', 'a.sight'], FILES)
    expect(code).toBe(0)
    expect(out).toContain('the runs behave the same: same outcome, same output, 3 matched calls')
  })

  test('calls made by one version only, renames, and a crash in one version', () => {
    const inserted = AVERAGE.replace('print(average', 'print(total(scores))\nprint(average')
    const renamed = AVERAGE.replaceAll('total', 'sum_of')
    const crash = 'fn at(xs, i) { xs[i] }\nprint(at([1, 2], 1))\n'
    const files = {
      'a.sight': AVERAGE,
      'i.sight': inserted,
      'r.sight': renamed,
      'c.sight': crash,
      'd.sight': crash.replace('xs[i]', 'xs[i + 5]'),
    }
    const insertedRun = cli(['diff', 'a.sight', 'i.sight'], files)
    expect(insertedRun.out).toContain('calls only in B (1):')
    expect(insertedRun.out).toMatch(/\+ total\(scores = \[92, 88, 95\]\) returned 275 {2}step \d+/)
    expect(insertedRun.out).toContain('✓ the top-level code: given the same inputs')
    const removedRun = cli(['diff', 'i.sight', 'a.sight'], files)
    expect(removedRun.out).toContain('calls only in A (1):')
    const renamedRun = cli(['diff', 'a.sight', 'r.sight'], files)
    expect(renamedRun.code).toBe(0)
    expect(renamedRun.out).toContain('the runs behave the same')
    const crashRun = cli(['diff', 'c.sight', 'd.sight'], files)
    expect(crashRun.code).toBe(1)
    expect(crashRun.out).toMatch(/B: \d+ steps, ends with R\d+/)
    expect(crashRun.out).toContain('· outcome, result, error')
  })

  test('--limit caps every list and says how many more there are', () => {
    const fib = (base: string) =>
      `fn fib(n) { if n < 2 { ${base} } else { fib(n - 1) + fib(n - 2) } }\nprint(fib(8))\n`
    const { code, out } = cli(['diff', 'a.sight', 'b.sight', '--limit', '2'], {
      'a.sight': fib('n'),
      'b.sight': fib('1'),
    })
    expect(code).toBe(1)
    expect(out).toMatch(/… [\d,]+ more \(raise --limit\)/)
    expect(out).toMatch(/\(\d+ identical calls\)/)
  })

  test('colour is used when the terminal takes it', () => {
    expect(cli(['diff', 'a.sight', 'b.sight'], FILES, true).out).toContain('\u001b[')
  })
})

describe('hindsight diff FILE --set NAME=VALUE', () => {
  test('a run with a different input: the top level is where the change starts', () => {
    const { code, out } = cli(['diff', 'a.sight', '--set', 'scores=[70, 80]'], FILES)
    expect(code).toBe(1)
    expect(out).toContain(
      'diff a.sight: A as written, B with scores = [70, 80] (line 9; it was [92, 88, 95])',
    )
    expect(out).toContain('(given other inputs)')
    expect(out).toContain(
      '✓ the top-level code (line 9, where scores is set): given the same inputs, it behaves differently and passes other values to the calls it makes',
    )
  })

  test('the same value again behaves the same', () => {
    expect(cli(['diff', 'a.sight', '--set', 'scores=[92, 88, 95]'], FILES).code).toBe(0)
  })

  test('names, values and programs that do not work are trouble: exit 2', () => {
    const unknown = cli(['diff', 'a.sight', '--set', 'nope=1'], FILES)
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain('no top-level let or var named nope (it has scores)')
    expect(cli(['diff', 'a.sight', '--set', 'scores=total(1)'], FILES).code).toBe(2)
    const broken = cli(['diff', 'x.sight', 'a.sight'], { 'x.sight': 'let = 1\n', ...FILES })
    expect(broken.code).toBe(2)
    expect(cli(['diff', 'a.sight', 'missing.sight'], FILES).code).toBe(2)
    const unbound = cli(['diff', 'u.sight', '--set', 'x=1'], { 'u.sight': 'let x = 1\nprint(y)\n' })
    expect(unbound.code).toBe(2)
    const strict = cli(['diff', 'u.sight', '--set', 'x=[1, 2]'], {
      'u.sight': 'let x = 1\nlet y = x + 1\nprint(y)\n',
    })
    expect(strict.code).toBe(1)
  })
})

describe('diff arguments', () => {
  test('parses both forms with their options', () => {
    expect(parseArgs(['diff', 'a', 'b', '--limit', '7', '--max-steps', '100'])).toMatchObject({
      ok: true,
      command: { kind: 'diff', fileA: 'a', fileB: 'b', set: null, limit: 7, maxSteps: 100 },
    })
    expect(parseArgs(['diff', 'a', '--set', 'n=[1, 2]', '--seed', '3'])).toMatchObject({
      ok: true,
      command: { kind: 'diff', fileA: 'a', fileB: null, set: { name: 'n', value: '[1, 2]' } },
    })
  })

  test('usage errors exit 2', () => {
    for (const args of [
      ['diff'],
      ['diff', 'a'],
      ['diff', 'a', 'b', 'c'],
      ['diff', 'a', 'b', '--set', 'n=1'],
      ['diff', '--set', 'n=1'],
      ['diff', 'a', '--set', '1=2'],
      ['diff', 'a', 'b', '--limit', '0'],
      ['diff', 'a', 'b', '--at', '3'],
    ]) {
      expect(cli(args, FILES).code).toBe(2)
    }
  })
})
