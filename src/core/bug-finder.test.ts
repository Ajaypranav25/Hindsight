import { describe, expect, test } from 'vitest'
import {
  type Answer,
  answer,
  type FinderState,
  question,
  startFinder,
  undo,
  verdict,
} from './bug-finder'
import { type CallDetails, type CallNode, type CallTree, callTree } from './calls'
import { compile, type Program, record, run } from './index'

function compiled(source: string): Program {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return result.program
}

function treeOf(source: string): CallTree {
  return callTree(record(compiled(source)))
}

type Oracle = (details: CallDetails) => Answer

/** Judges a call by running the same call against corrected definitions. */
function corrected(definitions: string): Oracle {
  return (details) => {
    if (details.result === null) return 'wrong'
    const call = `${details.call.name}(${details.args.map((arg) => arg.text).join(', ')})`
    // The corrected program's own output comes first; the call's repr is the last line.
    const result = run(compiled(`${definitions}\nprint(repr(${call}))\n`))
    return result.outputs.at(-1)?.text === details.result.text ? 'right' : 'wrong'
  }
}

interface Interview {
  readonly state: FinderState
  readonly asked: readonly CallDetails[]
}

function interview(tree: CallTree, oracle: Oracle, from?: CallNode, justMyCode = true): Interview {
  let state = startFinder(tree, from ?? tree.root, { justMyCode })
  const asked: CallDetails[] = []
  for (let call = question(state); call !== null; call = question(state)) {
    const details = tree.details(call)
    asked.push(details)
    if (asked.length > 200) throw new Error('the interview does not end')
    state = answer(state, oracle(details))
  }
  return { state, asked }
}

function found(state: FinderState): { name: string; certainty: string; lines: unknown } | null {
  const result = verdict(state)
  if (result.kind !== 'found') return null
  const tree = state.tree as CallTree
  return {
    name: result.call.name,
    certainty: result.certainty,
    lines: tree.details(result.call).lines,
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
fn report(groups) {
  map(groups, average)
}
print(report([[88, 83, 79], [90, 70]]))
`

const AVERAGE_FIXED = AVERAGE.replace('(len(xs) - 1)', 'len(xs)')

describe('finding single planted bugs', () => {
  test('an average that divides by the wrong count', () => {
    const tree = treeOf(AVERAGE)
    const { state, asked } = interview(tree, corrected(AVERAGE_FIXED))
    expect(found(state)).toEqual({
      name: 'average',
      certainty: 'certain',
      lines: { start: 8, end: 10 },
    })
    expect(asked.map((d) => `${d.call.name}(${d.args.map((a) => a.text).join(', ')})`)).toEqual([
      'report([[88, 83, 79], [90, 70]])',
      'average([88, 83, 79])',
      'total([88, 83, 79])',
    ])
    expect(asked[1]!.result?.text).toBe('125')
  })

  test('a recursive function with a wrong base case', () => {
    const source = `fn fact(n) {
  if n <= 1 { return 0 }
  n * fact(n - 1)
}
fn choose(n, k) {
  fact(n) / (fact(k) * fact(n - k))
}
print(choose(5, 2))
`
    const tree = treeOf(source)
    const { state, asked } = interview(tree, corrected(source.replace('return 0', 'return 1')))
    expect(found(state)).toMatchObject({ name: 'fact', certainty: 'certain' })
    expect(verdict(state)).toMatchObject({ call: { name: 'fact' } })
    const culprit = verdict(state).kind === 'found' ? tree.details(state.suspect) : null
    expect(culprit?.args[0]?.text).toBe('1')
    expect(asked.map((d) => d.call.name)).toEqual([
      'choose',
      'fact',
      'fact',
      'fact',
      'fact',
      'fact',
    ])
  })

  test('a correct-looking caller whose helper is off by one', () => {
    const source = `fn range_sum(lo, hi) {
  var s = 0
  for i in lo..hi {
    s += i
  }
  s
}
fn triangle(n) {
  range_sum(1, n)
}
fn total_triangles(n) {
  var t = 0
  for k in 1..=n {
    t += triangle(k)
  }
  t
}
print(total_triangles(3))
`
    const tree = treeOf(source)
    const { state } = interview(tree, corrected(source.replace('lo..hi', 'lo..=hi')))
    expect(found(state)).toEqual({
      name: 'range_sum',
      certainty: 'certain',
      lines: { start: 1, end: 7 },
    })
  })

  const CELSIUS = `fn celsius(temps) {
  map(temps, |f| (f - 32) * 5 / 6)
}
print(celsius([32, 212]))
`
  /** The callback cannot be called by name, so this oracle knows the right answers. */
  const celsiusOracle: Oracle = (details) => {
    const expected: Record<string, string> = {
      'celsius([32, 212])': '[0, 100]',
      'lambda(32)': '0',
      'lambda(212)': '100',
      'map([32, 212], <fn>)': '[0, 100]',
    }
    const call = `${details.call.name}(${details.args.map((arg) => arg.text).join(', ')})`
    return expected[call] === details.result?.text ? 'right' : 'wrong'
  }

  test('a bug in a callback passed to map (just-my-code lifts the callback)', () => {
    const tree = treeOf(CELSIUS)
    const { state, asked } = interview(tree, celsiusOracle)
    expect(found(state)).toEqual({
      name: 'lambda',
      certainty: 'certain',
      lines: { start: 2, end: 2 },
    })
    expect(asked.map((d) => d.call.name)).toEqual(['celsius', 'lambda', 'lambda'])
  })

  test('without just-my-code the library call is asked about too', () => {
    const tree = treeOf(CELSIUS)
    const { state, asked } = interview(tree, celsiusOracle, undefined, false)
    expect(found(state)).toMatchObject({ name: 'lambda', certainty: 'certain' })
    expect(asked.map((d) => d.call.name)).toEqual(['celsius', 'map', 'lambda', 'lambda'])
  })
})

describe('memoization', () => {
  const TRIBBLE = `fn fib(n) {
  if n < 2 { return n }
  fib(n - 1) + fib(n - 2)
}
fn tribble(n) {
  if n == 0 { return 0 }
  fib(5) + tribble(n - 1) + 1
}
print(tribble(4))
`
  const TRIBBLE_FIXED = TRIBBLE.replace(' + 1\n', '\n')

  test('identical calls are asked about once', () => {
    const tree = treeOf(TRIBBLE)
    const { state, asked } = interview(tree, corrected(TRIBBLE_FIXED))
    expect(found(state)).toMatchObject({ name: 'tribble', certainty: 'certain' })
    expect(asked.map((d) => `${d.call.name}(${d.args[0]!.text})`)).toEqual([
      'tribble(4)',
      'fib(5)',
      'tribble(3)',
      'tribble(2)',
      'tribble(1)',
      'tribble(0)',
    ])
    expect(state.asked).toBe(6)
    const remembered = state.judgments.filter((judgment) => judgment.remembered)
    expect(remembered.map((judgment) => [judgment.call.name, judgment.answer])).toEqual([
      ['fib', 'right'],
      ['fib', 'right'],
      ['fib', 'right'],
    ])
    const keys = asked.map((details) => details.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('a recursive search asks at most once per distinct call', () => {
    const source = `fn fib(n) {
  if n < 2 { return 1 }
  fib(n - 1) + fib(n - 2)
}
print(fib(12))
`
    const tree = treeOf(source)
    const { state, asked } = interview(tree, corrected(source.replace('return 1', 'return n')))
    expect(found(state)).toMatchObject({ name: 'fib', certainty: 'certain' })
    expect(asked.length).toBeLessThanOrEqual(13)
    expect(tree.details(state.suspect).args[0]!.text).toBe('0')
  })
})

describe('the interview', () => {
  const tree = treeOf(AVERAGE)

  test('undo goes back to the previous question', () => {
    const start = startFinder(tree, tree.root)
    const first = question(start)
    const afterWrong = answer(start, 'wrong')
    expect(question(afterWrong)?.name).toBe('average')
    const back = undo(afterWrong)
    expect(back).toBe(start)
    expect(question(back)).toBe(first)
    expect(undo(start)).toBe(start)
    const afterRight = answer(back, 'right')
    expect(question(afterRight)).toBeNull()
    expect(verdict(afterRight)).toMatchObject({ kind: 'found', call: tree.root })
  })

  test('there is no verdict while a question is open, and answering after the end does nothing', () => {
    const start = startFinder(tree, tree.root)
    expect(verdict(start)).toEqual({ kind: 'none' })
    const done = answer(start, 'right')
    expect(answer(done, 'wrong')).toBe(done)
    expect(done.asked).toBe(1)
  })

  test('an unsure answer makes the verdict likely, not certain', () => {
    const oracle = corrected(AVERAGE_FIXED)
    const { state } = interview(tree, (details) =>
      details.call.name === 'total' ? 'unsure' : oracle(details),
    )
    expect(found(state)).toMatchObject({ name: 'average', certainty: 'likely' })
  })

  test('starting from a chosen call searches below it', () => {
    const report = tree.children(tree.root)[0]!
    const average = tree.children(report, { justMyCode: true })[1]!
    const { state, asked } = interview(tree, corrected(AVERAGE_FIXED), average)
    expect(state.start).toBe(average)
    expect(found(state)).toMatchObject({ name: 'average' })
    expect(asked.map((d) => d.call.name)).toEqual(['total'])
  })

  test('an identical call to the starting one counts as wrong', () => {
    const source = 'fn f(x) {\n  x + 1\n}\nfn g() {\n  f(1)\n}\nf(1)\ng()\n'
    const loop = callTree(record(compiled(source)))
    const [f, g] = loop.children(loop.root)
    const state = answer(startFinder(loop, loop.root), 'right')
    expect(question(state)).toBe(g)
    const fromF = startFinder(loop, f!)
    expect(fromF.memo.get(loop.keyOf(f!)!)).toBe('wrong')
  })
})

describe('calls that did not return', () => {
  test('a raised call judged wrong leads to the function whose code raised', () => {
    const source = `fn get(xs, i) {
  xs[i]
}
fn second(xs) {
  get(xs, 2)
}
print(second([1, 2]))
`
    const tree = treeOf(source)
    const { state, asked } = interview(tree, (details) =>
      details.call.name === 'get' ? 'right' : 'wrong',
    )
    expect(asked.map((d) => [d.call.name, d.call.outcome, d.error?.code !== undefined])).toEqual([
      ['second', 'raised', true],
      ['get', 'raised', true],
    ])
    expect(found(state)).toMatchObject({ name: 'second', certainty: 'certain' })
  })

  test('a call cut off by the step limit can be followed down to the loop', () => {
    const source = `fn spin(n) {
  var i = n
  while i != 0 {
    i += 1
  }
  i
}
fn start() {
  spin(1)
}
start()
`
    const recording = record(compiled(source), { maxSteps: 500 })
    const tree = callTree(recording)
    const { state, asked } = interview(tree, () => 'wrong')
    expect(asked.map((d) => [d.call.name, d.call.outcome, d.key])).toEqual([
      ['start', 'unfinished', null],
      ['spin', 'unfinished', null],
    ])
    expect(found(state)).toMatchObject({ name: 'spin', certainty: 'certain' })
  })
})
