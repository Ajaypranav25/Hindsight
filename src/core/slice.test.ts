import { describe, expect, test } from 'vitest'
import { dependenceOf } from './dependence'
import { compile, record, type Recording } from './index'
import { backwardSlice, errorSlice, upstreamWrites } from './slice'

function recorded(source: string, maxSteps?: number): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program, { maxSteps })
}

/** The lines in the slice of the last output line (or of the failing instruction). */
function sliceLines(source: string): number[] {
  const recording = recorded(source)
  const slice =
    recording.outcome.kind === 'error'
      ? errorSlice(recording)
      : backwardSlice(recording, recording.outputs.at(-1)!.time)
  if (slice === null) throw new Error('no slice')
  return [...slice.lines].sort((a, b) => a - b)
}

describe('dependence graph', () => {
  test('every step depends only on earlier steps', () => {
    const recording = recorded(
      'fn fib(n) { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } }\nprint(fib(10))\n',
    )
    const graph = dependenceOf(recording)!
    expect(graph.length).toBe(recording.length)
    for (let t = 0; t <= graph.length; t++) {
      for (const dep of graph.depsOf(t)) expect(dep).toBeLessThan(t)
    }
  })

  test('is shared between callers', () => {
    const recording = recorded('print(1)\n')
    expect(dependenceOf(recording)).toBe(dependenceOf(recording))
  })
})

describe('backward slices', () => {
  test('follow the values an output was computed from', () => {
    const source = 'let a = 1\nlet b = 2\nlet c = a + 10\nlet unrelated = b * 3\nprint(c)\n'
    expect(sliceLines(source)).toEqual([1, 3, 5])
  })

  test('include the branch that chose the value, not the value it replaced', () => {
    const source = 'let x = 5\nvar y = 0\nif x > 3 { y = 1 } else { y = 2 }\nlet z = 7\nprint(y)\n'
    expect(sliceLines(source)).toEqual([1, 3, 5])
  })

  test('pass through parameters and returns', () => {
    const source = 'fn add(a, b) { a + b }\nlet p = 2\nlet q = 3\nlet r = 4\nprint(add(p, q))\n'
    expect(sliceLines(source)).toEqual([1, 2, 3, 5])
  })

  test('only the argument a function uses is upstream', () => {
    const source = 'fn first(a, b) { a }\nlet p = 2\nlet q = 3\nprint(first(p, q))\n'
    expect(sliceLines(source)).toEqual([1, 2, 4])
  })

  test('of a crash: the operands of the failing instruction', () => {
    const source = 'let xs = [1, 2, 3]\nlet i = 5\nlet k = 9\nprint(xs[i])\n'
    expect(sliceLines(source)).toEqual([1, 2, 4])
  })

  test('track record fields one by one', () => {
    const source = 'let o = {a: 1, b: 2}\no.a = 10\no.b = 20\nprint(o.b)\n'
    expect(sliceLines(source)).toEqual([1, 3, 4])
  })

  test('track list elements through writes', () => {
    const source = 'let xs = [1, 2, 3]\nxs[0] = 10\nxs[2] = 30\nlet n = 4\nprint(xs[2])\n'
    expect(sliceLines(source)).toEqual([1, 3, 5])
  })

  test('follow a loop that accumulates', () => {
    const source = 'var t = 0\nfor x in [1, 2, 3] { t += x }\nlet u = 99\nprint(t)\n'
    expect(sliceLines(source)).toEqual([1, 2, 4])
  })

  test('an early return makes the rest of the function depend on its condition', () => {
    const source =
      'fn f(n) {\n  if n > 2 { return 0 }\n  n * 2\n}\nlet m = 1\nlet other = 3\nprint(f(m))\n'
    // Line 1 defines f and line 4 is its implicit return; line 6 has no part in the result.
    expect(sliceLines(source)).toEqual([1, 2, 3, 4, 5, 7])
  })

  test('follow captured variables', () => {
    const source =
      'fn counter() {\n  var n = 0\n  fn() {\n    n += 1\n    n\n  }\n}\n' +
      'let next = counter()\nlet noise = 5\nnext()\nprint(next())\n'
    const lines = sliceLines(source)
    expect(lines).toContain(2)
    expect(lines).toContain(4)
    expect(lines).not.toContain(9)
  })

  test('natives read what they are given', () => {
    const source = 'let xs = [3, 1, 2]\nlet ys = [9]\npush(xs, 7)\nprint(len(xs))\n'
    expect(sliceLines(source)).toEqual([1, 3, 4])
  })

  test('a while loop depends on its condition and counter', () => {
    const source =
      'var i = 0\nvar s = 0\nvar junk = 0\nwhile i < 3 {\n  s += i\n  junk += 1\n  i += 1\n}\nprint(s)\n'
    expect(sliceLines(source)).toEqual([1, 2, 4, 5, 7, 9])
  })

  test('a what-if edit starts its own chain', () => {
    const real = recorded('let a = 1\nlet b = a + 1\nprint(b)\n')
    const at = real.lineHits(3)[0]!
    const b = real.stateAt(at).globals.find((global) => global.name === 'b')!
    const fork = real.fork(at, { target: b.target, value: 50 })
    if (!fork.ok) throw new Error(fork.error.message)
    const slice = backwardSlice(fork.recording, fork.recording.outputs[0]!.time)!
    expect([...slice.lines]).toEqual([3])
  })

  test('are null for runs that did not fail, when asked for the crash', () => {
    expect(errorSlice(recorded('print(1)\n'))).toBeNull()
  })
})

describe('upstream writes', () => {
  test('name the variables and parameters a result came from', () => {
    const source =
      'let rate = 0.2\nlet spare = 7\nfn price(base, tax) { base + base * tax }\nprint(price(100, rate))\n'
    const recording = recorded(source)
    const slice = backwardSlice(recording, recording.outputs[0]!.time)!
    const writes = upstreamWrites(recording, slice)
    const numbers = writes.filter((write) => typeof write.event.value === 'number')
    expect(writes.map((write) => write.name)).toContain('price')
    expect(
      numbers.map((write) => `${write.name}=${String(write.event.value)}@${write.line}`),
    ).toEqual(['rate=0.2@1', 'base=100@4', 'tax=0.2@4'])
  })
})
