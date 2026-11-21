import { describe, expect, test } from 'vitest'
import { compile, diffRuns, record, type Recording, withInput } from './index'

function recorded(source: string, maxSteps = 2_000_000): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program, { maxSteps })
}

const AVERAGE = `fn total(scores) {
  var sum = 0
  for s in scores { sum += s }
  sum
}
fn average(scores) {
  total(scores) / (len(scores) + 1)
}
let scores = [92, 88, 95]
print(average(scores))
`
const FIXED = AVERAGE.replace('len(scores) + 1', 'len(scores)')

const fib = (base: string, n: number): string =>
  `fn fib(n) { if n < 2 { ${base} } else { fib(n - 1) + fib(n - 2) } }\nprint(fib(${n}))\n`

describe('diffRuns: the same behavior', () => {
  test('two runs of one program behave the same and every call matches', () => {
    // Arrange
    const a = recorded(AVERAGE)
    const b = recorded(AVERAGE)

    // Act
    const diff = diffRuns(a, b)

    // Assert
    expect(diff).toMatchObject({
      same: true,
      sameOutcome: true,
      matched: 3,
      compared: 3,
      truncated: { nodes: false, compared: false },
      onlyA: { total: 0 },
      onlyB: { total: 0 },
      changed: { total: 0 },
      origins: { total: 0 },
      output: { removed: 0, added: 0 },
    })
    expect(diff.a).toMatchObject({ steps: a.length, outputs: 1, calls: 3 })
  })

  test('a renamed function is paired with its new name and is not a change', () => {
    const diff = diffRuns(recorded(AVERAGE), recorded(AVERAGE.replaceAll('total', 'sum_of')))
    expect(diff.renamed).toEqual([{ from: 'total', to: 'sum_of' }])
    expect(diff.same).toBe(true)
    expect(diff.matched).toBe(3)
  })
})

describe('diffRuns: where a change starts', () => {
  test('a changed constant: the function whose own code changed is the origin', () => {
    // Arrange
    const a = recorded(AVERAGE)
    const b = recorded(FIXED)

    // Act
    const diff = diffRuns(a, b)

    // Assert
    expect(diff.same).toBe(false)
    expect(diff.output).toMatchObject({ removed: 1, added: 1 })
    expect(diff.origins.total).toBe(1)
    const [origin] = diff.origins.items
    expect(origin).toMatchObject({
      count: 1,
      inputsChanged: false,
      changes: ['result'],
      a: { name: 'average', did: 'returned 68.75', lines: { start: 6, end: 8 } },
      b: { name: 'average', did: 'returned 91.66666666666667' },
    })
    expect(origin!.a.entry).toBeGreaterThan(0)
    expect(origin!.b.entry).toBe(origin!.a.entry)
    // The top level printed differently, but because a call it made returned something else.
    expect(diff.changed.items.map((change) => change.a.name)).toEqual(['<top level>', 'average'])
  })

  test('an inserted call is listed only in the second run; the caller is the origin', () => {
    const inserted = AVERAGE.replace(
      'print(average(scores))',
      'print(total(scores))\nprint(average(scores))',
    )
    const diff = diffRuns(recorded(AVERAGE), recorded(inserted))
    expect(diff.onlyA.total).toBe(0)
    expect(diff.onlyB.total).toBe(1)
    expect(diff.onlyB.items[0]).toMatchObject({
      name: 'total',
      signature: 'total(scores = [92, 88, 95])',
      did: 'returned 275',
      calls: 1,
    })
    expect(diff.origins.items[0]).toMatchObject({ a: { name: '<top level>' } })
    expect(diff.origins.items[0]!.changes).toContain('calls')
  })

  test('a removed call is listed only in the first run, with its subtree size', () => {
    const removed = AVERAGE.replace('total(scores) / ', '275 / ')
    const diff = diffRuns(recorded(AVERAGE), recorded(removed))
    expect(diff.onlyA.items).toMatchObject([{ name: 'total', calls: 1 }])
    expect(diff.onlyB.total).toBe(0)
    // average made a call the other version does not make: the change starts in average.
    expect(diff.origins.items).toMatchObject([{ a: { name: 'average' }, changes: ['calls'] }])
    expect(diff.same).toBe(false)
  })

  test('a different input: the top level, where the input is declared, is the origin', () => {
    // Arrange
    const input = withInput(AVERAGE, 'scores', '[70, 80]')
    if (!input.ok) throw new Error(input.error)

    // Act
    const diff = diffRuns(recorded(AVERAGE), recorded(input.source))

    // Assert
    expect(diff.origins.items).toMatchObject([{ a: { name: '<top level>' }, changes: ['output'] }])
    const average = diff.changed.items.find((change) => change.a.name === 'average')
    expect(average).toMatchObject({
      inputsChanged: true,
      changes: ['arguments', 'result'],
      b: { signature: 'average(scores = [70, 80])', did: 'returned 50' },
    })
  })

  test('recursion: identical origins are grouped, and same-named calls align by argument', () => {
    const diff = diffRuns(recorded(fib('n', 10)), recorded(fib('1', 10)))
    expect(diff.onlyA.total + diff.onlyB.total).toBe(0)
    expect(diff.origins.items).toHaveLength(1)
    expect(diff.origins.items[0]).toMatchObject({
      a: { signature: 'fib(n = 0)', did: 'returned 0' },
      b: { did: 'returned 1' },
    })
    expect(diff.origins.items[0]!.count).toBe(diff.origins.total)
    expect(diff.origins.total).toBeGreaterThan(10)
  })

  test('a shifted loop of calls aligns by argument, not by position', () => {
    const calls = (from: number) =>
      `fn sq(x) { x * x }\nvar t = 0\nfor i in ${from}..=4 { t += sq(i) }\nprint(t)\n`
    const diff = diffRuns(recorded(calls(1)), recorded(calls(2)))
    expect(diff.onlyA.items).toMatchObject([{ signature: 'sq(x = 1)' }])
    expect(diff.onlyB.total).toBe(0)
    expect(diff.changed.items.filter((change) => change.a.name === 'sq')).toEqual([])
  })

  test('side effects, output and globals read are compared too', () => {
    const effects = (step: number) =>
      `var count = 0\nlet scale = ${step}\nfn bump() { count += scale\n nil }\nfn say() { print("hi {count}") }\nbump()\nsay()\n`
    const diff = diffRuns(recorded(effects(1)), recorded(effects(2)))
    const bump = diff.changed.items.find((change) => change.a.name === 'bump')
    expect(bump).toMatchObject({ inputsChanged: true, changes: ['context', 'effects'] })
    const say = diff.changed.items.find((change) => change.a.name === 'say')
    expect(say).toMatchObject({ inputsChanged: true })
    expect(say!.changes).toContain('output')
    // bump read a different global: its change came from the top level.
    expect(diff.origins.items.map((origin) => origin.a.name)).toEqual(['<top level>'])
  })

  test('a crash in one version only: the outcomes differ and the raising call is the origin', () => {
    const safe = 'fn at(xs, i) { xs[i] }\nprint(at([1, 2, 3], 1))\n'
    const crash = safe.replace('xs[i]', 'xs[i + 5]')
    const diff = diffRuns(recorded(safe), recorded(crash))
    expect(diff.sameOutcome).toBe(false)
    expect(diff.b.outcome.kind).toBe('error')
    expect(diff.origins.items[0]).toMatchObject({ a: { name: 'at' }, b: { name: 'at' } })
    expect(diff.origins.items[0]!.changes).toEqual(expect.arrayContaining(['outcome', 'error']))
  })
})

describe('diffRuns: bounded work', () => {
  test('the node budget stops alignment and says so', () => {
    const diff = diffRuns(recorded(fib('n', 12)), recorded(fib('n', 12)), { maxNodes: 40 })
    expect(diff.truncated.nodes).toBe(true)
    expect(diff.matched).toBeLessThan(40)
  })

  test('the comparison budget stops comparisons and says so; lists are capped by limit', () => {
    const diff = diffRuns(recorded(fib('n', 12)), recorded(fib('1', 12)), {
      maxCompared: 25,
      limit: 3,
    })
    expect(diff.truncated).toEqual({ nodes: false, compared: true })
    expect(diff.compared).toBe(25)
    expect(diff.changed.items).toHaveLength(3)
    expect(diff.changed.total).toBeGreaterThan(3)
  })

  test('long lists of calls are aligned greedily without losing the matches', () => {
    const loop = (extra: string) =>
      `fn f(x) { x }\nfn g(x) { x }\nfor i in 0..700 { f(i) }\n${extra}for i in 0..700 { g(i) }\n`
    const diff = diffRuns(recorded(loop('')), recorded(loop('f(-1)\ng(-1)\n')))
    expect(diff.onlyB.total).toBe(2)
    expect(diff.onlyA.total).toBe(0)
    expect(diff.matched).toBe(1401)
  })

  test('deep recursion is handled without exhausting the JavaScript stack', () => {
    const deep = (n: number) =>
      `fn down(n) { if n == 0 { 0 } else { 1 + down(n - 1) } }\nprint(down(${n}))\n`
    const diff = diffRuns(recorded(deep(3000)), recorded(deep(3001)), { maxCompared: 50 })
    expect(diff.onlyB.total).toBe(1)
    expect(diff.matched).toBe(3002)
  })
})
