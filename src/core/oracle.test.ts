import { describe, expect, test } from 'vitest'
import {
  answer,
  autoAnswer,
  callTree,
  compile,
  contractOracle,
  type FinderState,
  question,
  record,
  type Recording,
  remaining,
  repairExamples,
  startFinder,
  type Strategy,
  undo,
  verdict,
} from './index'

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program, {})
}

/** An interview that only takes automatic answers. */
function interview(source: string, strategy: Strategy = 'divide') {
  const recording = recorded(source)
  const tree = callTree(recording)
  const oracle = contractOracle(recording, tree)
  const state = autoAnswer(startFinder(tree, tree.root, { strategy }), oracle)
  return { recording, tree, oracle, state }
}

function autoReasons(state: FinderState): string[] {
  return state.judgments.flatMap((judgment) =>
    judgment.auto === undefined
      ? []
      : [`${judgment.call.name} ${judgment.auto.answer}: ${judgment.auto.reason}`],
  )
}

const CHECKOUT = `fn subtotal(items)
  ensures result == sum(map(items, |i| i.price * i.qty))
{
  var total = 0
  for i in items { total += i.price * i.qty }
  total
}
fn shipping(amount)
  ensures result == (if amount >= 50 { 0 } else { 5 })
{
  if amount >= 50 { 0 } else { 5 }
}
fn total(items)
  ensures result >= subtotal(items)
{
  let sub = subtotal(items)
  sub - shipping(sub)
}
print(total([{price: 10, qty: 2}]))
`

const AVERAGES = `fn average(xs)
  requires len(xs) > 0
  ensures result == sum(xs) / len(xs)
{
  sum(xs) / len(xs)
}
fn report(groups) {
  var lines = []
  for g in groups { push(lines, average(g)) }
  lines
}
print(report([[1, 2], []]))
`

const TESTS = `fn add_tax(amount) { amount + amount / 10 }
fn total(prices) {
  var t = 0
  for p in prices { if p > 1 { t += p } }
  t
}
fn checkout(prices) { add_tax(total(prices)) }
assert(add_tax(100) == 110)
assert(3 == total([1, 2]))
print(checkout([1, 2]))
`

describe('the contract oracle (ARCHITECTURE §7.6)', () => {
  test.each<Strategy>(['divide', 'top-down'])(
    'a failed postcondition names the function with no human question (%s)',
    (strategy) => {
      // Arrange / Act
      const { state } = interview(CHECKOUT, strategy)
      const result = verdict(state)

      // Assert
      expect(result).toMatchObject({ kind: 'found', certainty: 'certain', call: { name: 'total' } })
      expect(state.asked).toBe(0)
      expect(state.answeredAutomatically).toBeGreaterThan(0)
      expect(autoReasons(state)).toContain('total wrong: its postcondition on line 14 failed')
      expect(autoReasons(state)).toContain('shipping right: its postcondition on line 9 held')
    },
  )

  test('a failed precondition clears the callee and blames its caller', () => {
    // Arrange / Act
    const { state, tree, oracle } = interview(AVERAGES)

    // Assert
    expect(verdict(state)).toMatchObject({ kind: 'found', call: { name: 'report' } })
    expect(state.asked).toBe(0)
    const report = tree.children(tree.root)[0]!
    const [first, second] = tree.children(report)
    expect(oracle(report)).toEqual({
      answer: 'wrong',
      reason: 'it broke the precondition of average on line 2',
      line: 2,
    })
    expect(oracle(second!)).toEqual({
      answer: 'right',
      reason: 'its precondition on line 2 failed: its caller is to blame',
      line: 2,
    })
    expect(oracle(first!)).toMatchObject({
      answer: 'right',
      reason: 'its postcondition on line 3 held',
    })
  })

  test('assertions are examples: a passed one says right, a failed one says wrong', () => {
    // Arrange / Act
    const { state, tree, oracle } = interview(TESTS)
    const [addTax, total] = tree.children(tree.root)

    // Assert
    expect(oracle(addTax!)).toEqual({ answer: 'right', reason: 'the assertion on line 8', line: 8 })
    expect(oracle(total!)).toEqual({
      answer: 'wrong',
      reason: 'the assertion on line 9 failed',
      line: 9,
    })
    expect(verdict(state)).toMatchObject({ kind: 'found', call: { name: 'total' } })
    expect(state.asked).toBe(0)
  })

  test('an assertion inside a function makes that function wrong too, so the search descends', () => {
    // Arrange
    const source = `fn double(n) { n * 3 }
fn test_double() {
  assert(double(2) == 4)
}
test_double()
`

    // Act
    const { state, tree, oracle } = interview(source)
    const testCall = tree.children(tree.root)[0]!

    // Assert
    expect(oracle(testCall)).toMatchObject({ answer: 'wrong', line: 3 })
    expect(verdict(state)).toMatchObject({ kind: 'found', call: { name: 'double' } })
    expect(state.asked).toBe(0)
  })

  test('a passed assertion with a pipe judges the piped call', () => {
    // Arrange
    const source = 'fn inc(n) { n + 1 }\nassert((1 |> inc()) == 2)\nprint(inc(5))\n'

    // Act
    const { tree, oracle } = interview(source)
    const [piped, plain] = tree.children(tree.root)

    // Assert
    expect(oracle(piped!)).toMatchObject({ answer: 'right', line: 2 })
    expect(oracle(plain!)).toBeNull()
  })

  test('postconditions that do not pin the result, and other calls, are left to a person', () => {
    // Arrange
    const source = `fn grow(n) ensures result > n { n * 2 }
fn plain(n) { n }
print(grow(3) + plain(1))
`

    // Act
    const { state, tree, oracle } = interview(source)

    // Assert
    for (const call of tree.children(tree.root)) expect(oracle(call)).toBeNull()
    expect(oracle(tree.root)).toBeNull()
    expect(question(state)).not.toBeNull()
    expect(state.answeredAutomatically).toBe(0)
  })

  test('a pinned call that changed something outside itself is not vouched for', () => {
    // Arrange
    const source = `var log = []
fn noted(n) ensures result == n {
  push(log, n)
  n
}
fn clean(n) ensures result == n { n }
print(noted(1) + clean(2))
`

    // Act
    const { tree, oracle } = interview(source)
    const [noted, clean] = tree.children(tree.root)

    // Assert
    expect(oracle(noted!)).toBeNull()
    expect(oracle(clean!)).toMatchObject({ answer: 'right' })
  })

  test('identical calls share an automatic answer through the memo', () => {
    // Arrange / Act
    const { state } = interview(CHECKOUT)

    // Assert
    const subtotals = state.judgments.filter((judgment) => judgment.call.name === 'subtotal')
    expect(subtotals.map((judgment) => judgment.remembered)).toEqual([false, true])
    expect(subtotals[0]!.auto?.answer).toBe('right')
  })
})

describe('autoAnswer, undo and remaining', () => {
  test('an automatic answer can be taken back; the user then answers that question', () => {
    // Arrange
    const { state, oracle } = interview(TESTS)
    const before = state.answeredAutomatically

    // Act
    const undone = undo(state)
    const again = autoAnswer(undone, oracle)
    const asked = question(undone)

    // Assert
    expect(undone.answeredAutomatically).toBe(before - 1)
    expect(again).toBe(undone)
    expect(asked).not.toBeNull()
    expect(undone.declined.has(asked!.id)).toBe(true)
    const manual = answer(undone, 'wrong')
    expect(manual.asked).toBe(1)
    expect(verdict(autoAnswer(manual, oracle))).toMatchObject({ kind: 'found' })
  })

  test('remaining counts down as automatic answers clear suspects', () => {
    // Arrange
    const recording = recorded(CHECKOUT)
    const tree = callTree(recording)
    const start = startFinder(tree, tree.root, { strategy: 'divide' })

    // Act
    const done = autoAnswer(start, contractOracle(recording, tree))

    // Assert
    expect(remaining(start)).toBeGreaterThan(remaining(done))
    expect(remaining(done)).toBe(1)
  })

  test('autoAnswer does nothing once the search is over', () => {
    // Arrange
    const { state, oracle } = interview(CHECKOUT)

    // Act / Assert
    expect(autoAnswer(state, oracle)).toBe(state)
  })

  test('repair examples include automatic answers like human ones', () => {
    // Arrange
    const { state, tree } = interview(TESTS)

    // Act
    const examples = repairExamples(tree, state)

    // Assert
    expect(examples).toContainEqual(expect.objectContaining({ name: 'total', answer: 'wrong' }))
  })
})
