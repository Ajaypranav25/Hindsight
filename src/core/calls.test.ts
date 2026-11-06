import { describe, expect, test } from 'vitest'
import { type CallNode, type CallTree, callTree } from './calls'
import { buildCallIndex } from './calls-index'
import { compile, type Program, record, type Recording } from './index'

function compiled(source: string): Program {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return result.program
}

function treeOf(source: string, maxSteps?: number): { tree: CallTree; recording: Recording } {
  const recording = record(compiled(source), { maxSteps })
  return { tree: callTree(recording), recording }
}

const SUM_SQ = `fn sq(x) {
  x * x
}
fn sum_sq(a, b) {
  sq(a) + sq(b)
}
print(sum_sq(2, 3))
`

const names = (calls: readonly CallNode[]) => calls.map((call) => call.name)

describe('the call tree', () => {
  test('the root is the whole program', () => {
    const { tree, recording } = treeOf(SUM_SQ)
    expect(tree.root).toMatchObject({
      id: 0,
      entry: 0,
      exit: recording.length - 1,
      depth: 0,
      outcome: 'returned',
      name: '<top level>',
      library: false,
    })
    expect(tree.details(tree.root)).toMatchObject({ args: [], result: null, error: null })
    expect(tree.details(tree.root).lines).toEqual({ start: 1, end: 7 })
  })

  test('children are the calls one level deeper, in execution order', () => {
    const { tree } = treeOf(SUM_SQ)
    const [sumSq] = tree.children(tree.root)
    expect(names(tree.children(tree.root))).toEqual(['sum_sq'])
    expect(names(tree.children(sumSq!))).toEqual(['sq', 'sq'])
    const [first, second] = tree.children(sumSq!)
    expect(first!.entry).toBeLessThan(second!.entry)
    expect(tree.parent(first!)).toBe(sumSq)
    expect(tree.parent(tree.root)).toBeNull()
  })

  test('a call starts where the depth rises and exits on its return step', () => {
    const { tree, recording } = treeOf(SUM_SQ)
    const depths = recording.depthSeries()
    const [sumSq] = tree.children(tree.root)
    const call = tree.children(sumSq!)[1]!
    expect(depths[call.entry]).toBe(call.depth)
    expect(depths[call.entry - 1]).toBe(call.depth - 1)
    expect(depths[call.exit]).toBe(call.depth)
    expect(depths[call.exit + 1]).toBe(call.depth - 1)
    expect(recording.locationAt(call.exit)?.opName).toBe('Return')
    expect(recording.locationAt(call.entry)?.functionName).toBe('sq')
  })

  test('details: arguments at entry, the returned value, the function lines', () => {
    const { tree } = treeOf(SUM_SQ)
    const [sumSq] = tree.children(tree.root)
    const details = tree.details(sumSq!)
    expect(details.args.map((arg) => [arg.name, arg.text, arg.after])).toEqual([
      ['a', '2', null],
      ['b', '3', null],
    ])
    expect(details.result?.text).toBe('13')
    expect(details.result?.value).toEqual({ kind: 'number', value: 13 })
    expect(details.lines).toEqual({ start: 4, end: 6 })
    expect(tree.details(tree.children(sumSq!)[1]!).result?.text).toBe('9')
  })

  test('callAt finds the innermost call running at a time', () => {
    const { tree, recording } = treeOf(SUM_SQ)
    const [sumSq] = tree.children(tree.root)
    const second = tree.children(sumSq!)[1]!
    expect(tree.callAt(second.entry + 1)).toBe(second)
    expect(tree.callAt(second.exit + 1)).toBe(sumSq)
    expect(tree.callAt(0)).toBe(tree.root)
    expect(tree.callAt(recording.length)).toBe(tree.root)
    expect(tree.call(second.entry)).toBe(second)
    expect(tree.call(second.entry + 1)).toBeNull()
  })

  test('the tree is cached per recording', () => {
    const { tree, recording } = treeOf(SUM_SQ)
    expect(callTree(recording)).toBe(tree)
  })

  test('pattern parameters are named by their pattern', () => {
    const { tree } = treeOf('fn first([a, b], c) {\n  a + c\n}\nprint(first([1, 2], 10))\n')
    const details = tree.details(tree.children(tree.root)[0]!)
    expect(details.args.map((arg) => [arg.name, arg.text])).toEqual([
      ['[a, b]', '[1, 2]'],
      ['c', '10'],
    ])
    expect(details.result?.text).toBe('11')
  })

  test('strings show in repr form and lists by their preview', () => {
    const { tree } = treeOf('fn shout(s, xs) {\n  "{s}!"\n}\nprint(shout("hi", [1, "a"]))\n')
    const details = tree.details(tree.children(tree.root)[0]!)
    expect(details.args.map((arg) => arg.text)).toEqual(['"hi"', '[1, "a"]'])
    expect(details.result?.text).toBe('"hi!"')
  })

  test('an argument the call changed shows its value afterwards', () => {
    const source =
      'fn add_one(xs) {\n  push(xs, 1)\n  nil\n}\nlet ys = [5]\nadd_one(ys)\nprint(ys)\n'
    const { tree } = treeOf(source)
    const details = tree.details(tree.children(tree.root)[0]!)
    expect(details.args[0]).toMatchObject({ name: 'xs', text: '[5]', after: '[5, 1]' })
    expect(details.result?.text).toBe('nil')
  })
})

describe('call keys', () => {
  test('identical calls share a key; other arguments or results do not', () => {
    const { tree } = treeOf('fn f(x) {\n  x * 2\n}\nf(1)\nf(1)\nf(2)\n')
    const keys = tree.children(tree.root).map((call) => tree.details(call).key)
    expect(keys[0]).not.toBeNull()
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
  })

  test('long arguments with a common prefix get different keys', () => {
    const { tree } = treeOf('fn size(xs) {\n  len(xs)\n}\nsize(list(0..30))\nsize(list(0..31))\n')
    const [a, b] = tree.children(tree.root).map((call) => tree.details(call))
    expect(a!.args[0]!.text).toBe(b!.args[0]!.text)
    expect(a!.key).not.toBe(b!.key)
  })

  test('the same function with a different body is not the same call', () => {
    const { tree } = treeOf('fn f(x) {\n  x\n}\nfn g(x) {\n  x\n}\nf(1)\ng(1)\n')
    const [f, g] = tree.children(tree.root).map((call) => tree.details(call).key)
    expect(f).not.toBe(g)
  })
})

describe('outcomes', () => {
  test('calls open when the run failed raised, and carry the error', () => {
    const source =
      'fn get(xs, i) {\n  xs[i]\n}\nfn second(xs) {\n  get(xs, 2)\n}\nprint(second([1, 2]))\n'
    const { tree } = treeOf(source)
    const second = tree.children(tree.root)[0]!
    const get = tree.children(second)[0]!
    expect(tree.root.outcome).toBe('raised')
    expect([second.outcome, get.outcome]).toEqual(['raised', 'raised'])
    const details = tree.details(get)
    expect(details.result).toBeNull()
    expect(details.error?.code).toMatch(/^R\d{3}$/)
    expect(details.args.map((arg) => arg.text)).toEqual(['[1, 2]', '2'])
    expect(details.key).not.toBeNull()
  })

  test('calls cut off by the step limit are unfinished and never share a key', () => {
    const source = 'fn spin(n) {\n  var i = n\n  while true {\n    i += 1\n  }\n}\nspin(1)\n'
    const { tree, recording } = treeOf(source, 200)
    const spin = tree.children(tree.root)[0]!
    expect(recording.outcome.kind).toBe('step-limit')
    expect(spin.outcome).toBe('unfinished')
    expect(spin.exit).toBe(recording.length)
    expect(tree.details(spin)).toMatchObject({ result: null, error: null, key: null })
    expect(tree.root.outcome).toBe('unfinished')
  })
})

describe('just my code', () => {
  const DOUBLES =
    'fn double(x) {\n  x * 2\n}\nfn doubles(xs) {\n  map(xs, double)\n}\nprint(doubles([1, 2]))\n'

  test('library calls are replaced by the user calls they make', () => {
    const { tree } = treeOf(DOUBLES)
    const doubles = tree.children(tree.root, { justMyCode: true })[0]!
    expect(names(tree.children(doubles))).toEqual(['map'])
    expect(tree.children(doubles)[0]!.library).toBe(true)
    const lifted = tree.children(doubles, { justMyCode: true })
    expect(names(lifted)).toEqual(['double', 'double'])
    expect(lifted.map((call) => tree.details(call).args[0]!.text)).toEqual(['1', '2'])
    expect(tree.parent(lifted[0]!, { justMyCode: true })).toBe(doubles)
    expect(tree.parent(lifted[0]!)?.name).toBe('map')
    expect(tree.details(tree.children(doubles)[0]!).lines).toBeNull()
  })

  test('callAt with just-my-code skips library frames', () => {
    const { tree } = treeOf(DOUBLES)
    const doubles = tree.children(tree.root)[0]!
    const map = tree.children(doubles)[0]!
    expect(tree.callAt(map.entry)).toBe(map)
    expect(tree.callAt(map.entry, { justMyCode: true })).toBe(doubles)
  })
})

describe('the call index', () => {
  test('handles deep recursion in one pass', () => {
    const source = 'fn down(n) {\n  if n == 0 { 0 } else { down(n - 1) }\n}\nprint(down(3000))\n'
    const { tree } = treeOf(source)
    let call = tree.root
    let levels = 0
    for (let next = tree.children(call)[0]; next; next = tree.children(call)[0]) {
      call = next
      levels++
    }
    expect(levels).toBe(3001)
    expect(tree.details(call).args[0]!.text).toBe('0')
    expect(tree.callAt(call.entry)).toBe(call)
  })

  test('indexes depth series by hand', () => {
    const depths = Int32Array.from([0, 0, 1, 1, 2, 2, 1, 0, 1, 1, 0])
    const index = buildCallIndex(depths, depths.length)
    expect(index.count).toBe(4)
    expect([0, 1, 2, 3].map((i) => [index.entryOf(i), index.endOf(i), index.parentOf(i)])).toEqual([
      [0, 11, -1],
      [2, 7, 0],
      [4, 6, 1],
      [8, 10, 0],
    ])
    expect(index.childrenOf(0)).toEqual([1, 3])
    expect(index.childrenOf(1)).toEqual([2])
    expect(index.indexOfEntry(4)).toBe(2)
    expect(index.indexOfEntry(5)).toBe(-1)
    expect(index.innermostAt(5)).toBe(2)
    expect(index.innermostAt(7)).toBe(0)
    expect(index.innermostAt(11)).toBe(0)
  })

  test('calls still open at the end run to the end', () => {
    const depths = Int32Array.from([0, 1, 1, 2])
    const index = buildCallIndex(depths, depths.length)
    expect([0, 1, 2].map((i) => index.endOf(i))).toEqual([4, 4, 4])
    expect(index.innermostAt(4)).toBe(2)
  })

  test('an empty recording has just the root', () => {
    const index = buildCallIndex(new Int32Array(0), 0)
    expect(index.count).toBe(1)
    expect(index.childrenOf(0)).toEqual([])
    expect(index.innermostAt(0)).toBe(0)
  })
})
