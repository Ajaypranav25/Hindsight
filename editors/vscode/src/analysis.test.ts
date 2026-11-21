import { describe, expect, test } from 'vitest'
import { compile, record, recordAsync, type Recording } from '../../../src/core/index'
import {
  analyze,
  crashSlice,
  functionLenses,
  momentFor,
  neverRanLenses,
  runReport,
  statementLines,
  whyNotSentence,
} from './analysis'

function recorded(source: string, maxSteps?: number): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program, { maxSteps })
}

const BRANCHES = [
  'var total = 50', //                1
  'if total > 80 {', //               2
  '  print("free shipping")', //      3
  '  total = total - 5', //           4
  '} else {', //                      5
  '  print("pay shipping")', //       6
  '}', //                             7
  'print(total)', //                  8
].join('\n')

describe('analyze', () => {
  test('reports compile errors as problems with 1-based lines and columns, without running', async () => {
    // Arrange
    const source = 'let x = 1\nprint(x +)\n'

    // Act
    const analysis = await analyze(source)

    // Assert
    expect(analysis.kind).toBe('compile-error')
    if (analysis.kind !== 'compile-error') return
    expect(analysis.problems.length).toBeGreaterThan(0)
    expect(analysis.problems[0]).toMatchObject({ severity: 'error', start: { line: 2 } })
    expect(analysis.problems[0]!.code).toMatch(/^E\d{3}$/)
  })

  test('records a program that finishes, with no problems', async () => {
    const analysis = await analyze('print("hi")\n')

    expect(analysis.kind).toBe('recorded')
    if (analysis.kind !== 'recorded') return
    expect(analysis.problems).toEqual([])
    expect(analysis.recording.outputs.map((o) => o.text)).toEqual(['hi'])
  })

  test('turns a runtime error into a problem at its line, with the hint appended', async () => {
    const analysis = await analyze('let a = 1\nprint("total: " + a)\n')

    if (analysis.kind !== 'recorded') throw new Error(analysis.kind)
    expect(analysis.recording.outcome.kind).toBe('error')
    expect(analysis.problems).toHaveLength(1)
    const [problem] = analysis.problems
    expect(problem).toMatchObject({ severity: 'error', code: 'R001', start: { line: 2 } })
    expect(problem!.message).toContain('\nhint: ')
  })

  test('stops at the step budget', async () => {
    const analysis = await analyze('while true {\n}\n', { maxSteps: 500 })

    if (analysis.kind !== 'recorded') throw new Error(analysis.kind)
    expect(analysis.recording.outcome).toEqual({ kind: 'step-limit', maxSteps: 500 })
    expect(analysis.recording.length).toBe(500)
  })

  test('reports aborted when a newer run has already set the signal', async () => {
    const analysis = await analyze('print(1)\n', { signal: { aborted: true } })

    expect(analysis).toEqual({ kind: 'aborted' })
  })

  test('reports aborted when the signal is set while recording', async () => {
    // Arrange: a long loop recorded in 1 ms slices; the flag flips after the first slice.
    const signal = { aborted: false }
    const pending = analyze('var i = 0\nwhile i < 1000000 {\n  i += 1\n}\n', {
      signal,
      sliceMs: 1,
    })

    // Act
    await new Promise((resolve) => setTimeout(resolve, 0))
    signal.aborted = true

    // Assert
    expect(await pending).toEqual({ kind: 'aborted' })
  })
})

describe('function lenses', () => {
  test('count the calls of each declared function, recursion included', () => {
    const source = [
      'fn fib(n) {', //                         1
      '  if n < 2 { return n }', //             2
      '  return fib(n - 1) + fib(n - 2)', //    3
      '}', //                                   4
      'fn once() { return 1 }', //              5
      'fn unused() { return 2 }', //            6
      'print(fib(5) + once())', //              7
    ].join('\n')

    const lenses = functionLenses(recorded(source))

    expect(lenses).toEqual([
      { line: 1, name: 'fib', calls: 15, title: 'ran 15 times' },
      { line: 5, name: 'once', calls: 1, title: 'ran once' },
      { line: 6, name: 'unused', calls: 0, title: 'never called' },
    ])
  })

  test('skip lambdas and anonymous functions, and count calls made by library code', () => {
    const source = [
      'fn double(x) { return x * 2 }', //                     1
      'let inc = |x| x + 1', //                                2
      'print(map([1, 2, 3], double))', //                      3
      'print(inc(1))', //                                      4
    ].join('\n')

    const lenses = functionLenses(recorded(source))

    expect(lenses).toEqual([{ line: 1, name: 'double', calls: 3, title: 'ran 3 times' }])
  })

  test('include functions declared inside other functions', () => {
    const source =
      'fn outer() {\n  fn inner() { return 1 }\n  return inner() + inner()\n}\nouter()\n'

    const lenses = functionLenses(recorded(source))

    expect(lenses.map((l) => [l.line, l.name, l.calls])).toEqual([
      [1, 'outer', 1],
      [2, 'inner', 2],
    ])
  })

  test('format large counts with separators', () => {
    const source = 'fn f() { return 1 }\nfor i in 0..1500 {\n  f()\n}\n'

    expect(functionLenses(recorded(source))[0]!.title).toBe('ran 1,500 times')
  })
})

describe('never-ran lenses', () => {
  test('mark one lens per stretch of statement lines that never ran', () => {
    const recording = recorded(BRANCHES)

    expect(statementLines(recording.program)).toEqual([1, 2, 3, 4, 6, 8])
    expect(neverRanLenses(recording)).toEqual([
      { line: 3, lines: 2, title: 'never ran (2 lines) — why not?' },
    ])
  })

  test('mark a single unreached line, and nothing when every line ran', () => {
    const single = recorded('let x = 3\nif x > 5 {\n  print(x)\n}\nprint("done")\n')
    const all = recorded('print(1)\nprint(2)\n')

    expect(neverRanLenses(single)).toEqual([{ line: 3, lines: 1, title: 'never ran — why not?' }])
    expect(neverRanLenses(all)).toEqual([])
  })

  test('mark the code after a crash as never run', () => {
    const recording = recorded('print(1)\npanic("stop")\nprint(2)\nprint(3)\n')

    expect(neverRanLenses(recording)).toEqual([
      { line: 3, lines: 2, title: 'never ran (2 lines) — why not?' },
    ])
  })
})

describe('why not, crash slices and run reports', () => {
  test('explain why a line never ran', () => {
    expect(whyNotSentence(recorded(BRANCHES), 3)).toMatch(/^Line 3 never ran because/)
  })

  test('slice a crash into the lines that led to it and the lines to dim', () => {
    const source = [
      'let prices = [3, 4]', //          1
      'let unrelated = 10', //           2
      'print(unrelated)', //             3
      'let i = 2', //                    4
      'print(prices[i])', //             5
    ].join('\n')

    const slice = crashSlice(recorded(source))

    if (slice.kind !== 'sliced') throw new Error(slice.message)
    expect(slice.keep).toEqual([1, 4, 5])
    expect(slice.dim).toEqual([2, 3])
    expect(slice.message).toMatch(/^3 lines led to R\d{3}: /)
  })

  test('say there is no crash to slice when the run finished or hit the step limit', () => {
    const finished = crashSlice(recorded('print(1)\n'))
    const limited = crashSlice(recorded('while true {\n}\n', 1_000))

    expect(finished).toEqual({
      kind: 'no-crash',
      message: 'The last run did not crash: it finished normally.',
    })
    expect(limited.message).toBe(
      'The last run did not crash: it stopped at the step limit (1,000 steps).',
    )
  })

  test('say an aborted run did not crash', async () => {
    const compiled = compile('print(1)\n')
    if (!compiled.ok) throw new Error('compile failed')
    const aborted = await recordAsync(compiled.program, { signal: { aborted: true } })

    expect(crashSlice(aborted).message).toBe('The last run did not crash: it was stopped.')
  })

  test('say a crash cannot be sliced when the recording offers no replay', () => {
    // Arrange: a stand-in that has the crash but not the recorder's replay access.
    const real = recorded('print([1][3])\n')
    const standIn = { outcome: real.outcome, program: real.program, length: real.length }

    // Act
    const slice = crashSlice(standIn as unknown as Recording)

    // Assert
    expect(slice).toEqual({ kind: 'unavailable', message: 'This run cannot be sliced.' })
  })

  test('report the output and how the run ended', () => {
    const finished = recorded('print("a")\nprint("b")\n')
    const crashed = recorded('print("x")\nprint("n: " + 1)\n')
    const limited = recorded('while true {\n}\n', 2_000)

    expect(runReport(finished, 'f.sight')).toEqual([
      'a',
      'b',
      `[f.sight] finished normally after ${finished.length} steps`,
    ])
    const crash = runReport(crashed, 'c.sight')
    expect(crash[0]).toBe('x')
    expect(crash[1]).toMatch(/^\[c\.sight:2\] runtime error R001: .* \(after \d+ steps\)$/)
    expect(crash[2]).toMatch(/^ {2}hint: /)
    expect(runReport(limited, 'l.sight')).toEqual([
      '[l.sight] stopped at the step limit (2,000 steps); raise hindsight.maxSteps to record further',
    ])
  })

  test('put the studio pen on the first run of a line, else at the end of the run', () => {
    const recording = recorded(BRANCHES)

    expect(momentFor(recording, 8)).toBe(recording.lineHits(8)[0])
    expect(momentFor(recording, 3)).toBe(recording.length)
  })
})
