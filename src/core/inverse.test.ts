import { describe, expect, test } from 'vitest'
import { compile, record, type Recording } from './index'
import { inverseSearch, solveInverse, solveInverseAsync } from './inverse'

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program)
}

const PRICE =
  'let price = 200\nlet discount_rate = 0.2\nlet unrelated = 7\n' +
  'let total = price - price * discount_rate\nprint(total)\n'

describe('inverse what-if', () => {
  test('finds the upstream value that makes a line print a number', () => {
    const recording = recorded(PRICE)
    const result = solveInverse(recording, { kind: 'output', index: 0, text: '100' })
    expect(result.problem).toBeNull()
    expect(result.solutions.map((s) => `${s.candidate.name}=${String(s.value)}`)).toEqual([
      'discount_rate=0.5',
      'price=125',
    ])
    const [best] = result.solutions
    expect(best!.sentence).toBe(
      `If discount_rate at step ${best!.candidate.time} had been 0.5 instead of 0.2, line 5 would have printed 100.`,
    )
    // The answer is true: forking with it prints the goal.
    const fork = recording.fork(best!.candidate.time, {
      target: best!.candidate.target,
      value: best!.value,
    })
    expect(fork.ok && fork.recording.outputs[0]!.text).toBe('100')
    // Only what the line was computed from was tried.
    expect(result.candidates).toBe(2)
    expect(result.forks).toBeLessThan(10)
  })

  test('searches whole numbers through a loop (not linear)', () => {
    const source =
      'fn tri(n) {\n  var s = 0\n  for i in 1..=n { s += i }\n  s\n}\nlet n = 4\nprint(tri(n))\n'
    const result = solveInverse(recorded(source), { kind: 'output', index: 0, text: '55' })
    expect(result.solutions[0]).toMatchObject({ candidate: { name: 'n', original: 4 }, value: 10 })
    for (const solution of result.solutions) expect(Number.isInteger(solution.value)).toBe(true)
  })

  test('steers the number a labelled line changes', () => {
    const source = 'let rate = 3\nlet hours = 8\nprint("pay for {hours} hours: {rate * hours}")\n'
    const result = solveInverse(recorded(source), {
      kind: 'output',
      index: 0,
      text: 'pay for 8 hours: 40',
    })
    expect(result.solutions.map((s) => `${s.candidate.name}=${String(s.value)}`)).toEqual([
      'rate=5',
    ])
  })

  test('flips a boolean', () => {
    const source = 'let vip = false\nlet price = if vip { 80 } else { 100 }\nprint(price)\n'
    const result = solveInverse(recorded(source), { kind: 'output', index: 0, text: '80' })
    expect(result.solutions[0]).toMatchObject({ candidate: { name: 'vip' }, value: true })
  })

  test('makes a crash not happen', () => {
    const recording = recorded('let xs = [1, 2, 3]\nlet i = 5\nprint(xs[i])\n')
    const result = solveInverse(recording, { kind: 'no-error' })
    const [best] = result.solutions
    expect(best).toMatchObject({ candidate: { name: 'i', original: 5 } })
    expect(best!.sentence).toContain('the run would not have failed on line 3')
    expect(best!.sentence).toContain('it would have finished normally')
  })

  test('says why there is nothing to search', () => {
    const fine = recorded('print(len("abc"))\n')
    expect(solveInverse(fine, { kind: 'no-error' }).problem).toContain('did not fail')
    expect(solveInverse(fine, { kind: 'output', index: 3, text: '1' }).problem).toContain(
      'no output',
    )
    expect(solveInverse(fine, { kind: 'output', index: 0, text: '3' }).problem).toContain('already')
    expect(solveInverse(fine, { kind: 'output', index: 0, text: '9' }).problem).toContain(
      'No number',
    )
  })

  test('gives up on values the target does not move with, and respects the budget', () => {
    const source = 'let a = 2\nlet b = if a > 100 { 1 } else { 0 }\nprint(b * 0 + 5)\n'
    const stuck = solveInverse(recorded(source), { kind: 'output', index: 0, text: '6' })
    expect(stuck.solutions).toEqual([])
    expect(stuck.exhausted).toBe(false)
    const tight = solveInverse(
      recorded(PRICE),
      { kind: 'output', index: 0, text: '100' },
      { maxForks: 1 },
    )
    expect(tight).toMatchObject({ solutions: [], forks: 1, exhausted: true })
  })

  test('the generator asks for forks; the async driver gives the same answer', async () => {
    const recording = recorded(PRICE)
    const goal = { kind: 'output', index: 0, text: '100' } as const
    const first = inverseSearch(recording, goal).next()
    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({ edit: { value: expect.any(Number) } })
    const sync = solveInverse(recording, goal)
    const sliced = await solveInverseAsync(recording, goal)
    expect(sliced.solutions.map((s) => s.sentence)).toEqual(sync.solutions.map((s) => s.sentence))
    const stopped = await solveInverseAsync(recording, goal, { signal: { aborted: true } })
    expect(stopped.solutions).toEqual([])
  })
})
