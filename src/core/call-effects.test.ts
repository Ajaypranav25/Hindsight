import { describe, expect, test } from 'vitest'
import { answer, question, remaining, startFinder, verdict } from './bug-finder'
import { changeTexts, questionText } from './bug-finder-text'
import { callEffects } from './call-effects'
import { type CallNode, type CallTree, callTree } from './calls'
import { eventsBetween } from './events'
import { compile, record } from './index'

function treeOf(source: string): CallTree {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return callTree(record(result.program))
}

function firstCall(tree: CallTree, name: string): CallNode {
  for (const call of tree.calls()) if (call.name === name) return call
  throw new Error(`no call of ${name}`)
}

function effectsOf(source: string, name: string): string[] {
  const tree = treeOf(source)
  return callEffects(tree.recording, firstCall(tree, name)).effects.map((effect) => effect.text)
}

describe('eventsBetween', () => {
  test('lists the events of a window in time order and counts the rest', () => {
    const tree = treeOf('var a = 1\na = 2\nlet xs = [a]\npush(xs, 3)\n')
    const all = eventsBetween(tree.recording, 0, tree.recording.length)
    expect(all.truncated).toBe(false)
    expect(all.events.map((event) => event.kind)).toEqual([
      'declare',
      'write',
      'alloc',
      'declare',
      'list',
    ])
    const times = all.events.map((event) => event.time)
    expect(times).toEqual([...times].sort((x, y) => x - y))
    const limited = eventsBetween(tree.recording, 0, tree.recording.length, 2)
    expect(limited.events).toHaveLength(2)
    expect(limited.total).toBe(5)
    expect(limited.truncated).toBe(true)
    expect(eventsBetween(tree.recording, times[1]!, times[1]! + 1).events).toHaveLength(1)
  })
})

describe('call effects', () => {
  test('a pure call has none', () => {
    expect(effectsOf('fn double(n) { n * 2 }\nprint(double(4))\n', 'double')).toEqual([])
  })

  test('assigning a global is an effect; the last value counts', () => {
    const source = 'var total = 0\nfn add(n) {\n  total += n\n  total += n\n  n\n}\nadd(5)\n'
    expect(effectsOf(source, 'add')).toEqual(['global total became 10'])
  })

  test('a record reached through a global is named by its path', () => {
    const source =
      'let shop = {till: {cash: 5}, open: false}\n' +
      'fn sell(price) {\n  shop.till.cash = shop.till.cash + price\n  shop.open = true\n  price\n}\n' +
      'sell(3)\n'
    expect(effectsOf(source, 'sell')).toEqual(['shop.till.cash became 8', 'shop.open became true'])
  })

  test('changes to an argument are left to the argument texts', () => {
    const source = 'fn pay(order) {\n  order.paid = true\n  118\n}\nlet o = {paid: false}\npay(o)\n'
    const tree = treeOf(source)
    const details = tree.details(firstCall(tree, 'pay'))
    expect(details.effects).toEqual([])
    expect(changeTexts(details)).toEqual(['order became {paid: true}'])
    expect(questionText(details)).toBe(
      'pay(order = {paid: false}) returned 118 and changed: order became {paid: true}. Is that right?',
    )
  })

  test('a captured variable and a list outside the call', () => {
    const source =
      'let log = []\n' +
      'fn counter() {\n  var n = 0\n  fn() {\n    n += 1\n    push(log, n)\n    n\n  }\n}\n' +
      'let next = counter()\nnext()\nnext()\n'
    const tree = treeOf(source)
    const calls = [...tree.calls()].filter((call) => call.name === 'lambda')
    expect(calls).toHaveLength(2)
    const texts = (call: CallNode) =>
      callEffects(tree.recording, call).effects.map((effect) => effect.text)
    expect(texts(calls[0]!)).toEqual(['captured n became 1', 'log changed (1 change)'])
    expect(texts(calls[1]!)).toEqual(['captured n became 2', 'log changed (1 change)'])
  })

  test('objects the call made itself are not effects', () => {
    const source =
      'fn make() {\n  let r = {a: 1}\n  r.a = 2\n  let xs = []\n  push(xs, r)\n  xs\n}\nmake()\n'
    expect(effectsOf(source, 'make')).toEqual([])
  })

  test('calls with the same arguments and result but different effects are different calls', () => {
    const source =
      'var hits = 0\nfn touch(n) {\n  hits += 1\n  n\n}\nfn pure(n) { n }\n' +
      'touch(1)\ntouch(1)\npure(1)\npure(1)\n'
    const tree = treeOf(source)
    const keys = (name: string) =>
      [...tree.calls()].filter((call) => call.name === name).map((call) => tree.keyOf(call))
    const [first, second] = keys('touch')
    expect(first).not.toBeNull()
    expect(first).not.toBe(second)
    const [a, b] = keys('pure')
    expect(a).toBe(b)
  })
})

describe('divide and query', () => {
  // A chain of 64 calls: step(64) calls step(63) … calls step(1). Only step(5) is wrong.
  const CHAIN =
    'fn step(n) {\n  if n == 0 { return 0 }\n  let below = step(n - 1)\n' +
    '  if n == 5 { below + 100 } else { below + 1 }\n}\nprint(step(64))\n'

  function interview(tree: CallTree, strategy: 'divide' | 'top-down') {
    let state = startFinder(tree, tree.root, { strategy })
    let asked = 0
    for (let call = question(state); call !== null; call = question(state)) {
      const n = tree.details(call).args[0]!.value
      const wrong = n.kind === 'number' && n.value >= 5
      state = answer(state, wrong ? 'wrong' : 'right')
      asked += 1
      if (asked > 200) throw new Error('the interview does not end')
    }
    return { state, asked }
  }

  test('finds the same culprit as top-down in about log2(N) questions', () => {
    const tree = treeOf(CHAIN)
    const divide = interview(tree, 'divide')
    const topDown = interview(tree, 'top-down')
    const culprit = (state: typeof divide.state) => {
      const result = verdict(state)
      if (result.kind !== 'found') throw new Error('no verdict')
      return tree.details(result.call).args[0]!.text
    }
    expect(culprit(divide.state)).toBe('5')
    expect(culprit(topDown.state)).toBe('5')
    expect(topDown.asked).toBeGreaterThan(55)
    expect(divide.asked).toBeLessThanOrEqual(8)
  })

  test('each answer shrinks what is left, and the first question splits it in half', () => {
    const tree = treeOf(CHAIN)
    let state = startFinder(tree, tree.root, { strategy: 'divide' })
    const total = remaining(state)
    expect(total).toBe(66)
    const first = question(state)!
    expect(tree.size(first)).toBe(33)
    state = answer(state, 'right')
    expect(remaining(state)).toBe(33)
    state = answer(state, 'wrong')
    expect(remaining(state)).toBeLessThan(33)
  })

  test('unsure answers clear the call but make the verdict only likely', () => {
    const tree = treeOf('fn a() { b() }\nfn b() { 1 }\nprint(a())\n')
    let state = startFinder(tree, tree.root, { strategy: 'divide' })
    while (question(state) !== null) state = answer(state, 'unsure')
    expect(verdict(state)).toMatchObject({ kind: 'found', certainty: 'likely' })
    expect(verdict(state)).toMatchObject({ call: { depth: 0 } })
  })

  test('a tree without sizes is counted through its children', () => {
    const tree = treeOf(CHAIN)
    const plain = {
      children: (call: CallNode, options: { justMyCode: boolean }) => tree.children(call, options),
      keyOf: (call: CallNode) => tree.keyOf(call),
    }
    const state = startFinder(plain, tree.root, { strategy: 'divide' })
    expect(remaining(state)).toBe(66)
    expect(question(state)).toBe(question(startFinder(tree, tree.root, { strategy: 'divide' })))
  })

  test('just-my-code sizes count user calls only', () => {
    const tree = treeOf('fn sq(n) { n * n }\nprint(map([1, 2, 3], sq))\n')
    expect(tree.size(tree.root, { justMyCode: true })).toBe(4)
    expect(tree.size(tree.root)).toBeGreaterThan(4)
  })
})
