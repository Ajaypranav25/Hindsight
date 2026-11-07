/**
 * Properties of the bug finder over generated call trees with one planted bug: the buggy call and
 * every call above it went wrong, all others are right; identical calls share a key.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { type Answer, answer, type FinderTree, question, startFinder, verdict } from './bug-finder'
import type { CallNode } from './calls'

interface Scenario {
  readonly nodes: readonly CallNode[]
  readonly parents: readonly number[]
  readonly children: readonly (readonly number[])[]
  readonly bug: number
  /** Calls the user is unsure about. */
  readonly unsure: ReadonlySet<number>
  readonly keys: readonly (string | null)[]
}

function wrongCalls(parents: readonly number[], bug: number): Set<number> {
  const wrong = new Set<number>()
  for (let call = bug; call >= 0; call = parents[call]!) wrong.add(call)
  return wrong
}

const scenario: fc.Arbitrary<Scenario> = fc
  .record({
    links: fc.array(fc.nat(), { maxLength: 40 }),
    bugSeed: fc.nat(),
    unsureSeeds: fc.array(fc.nat(), { maxLength: 6 }),
    groups: fc.array(fc.option(fc.integer({ min: 0, max: 3 })), { minLength: 41, maxLength: 41 }),
  })
  .map(({ links, bugSeed, unsureSeeds, groups }) => {
    const count = links.length + 1
    const parents = [-1, ...links.map((link, i) => link % (i + 1))]
    const children = parents.map((_, call) =>
      parents.flatMap((parent, child) => (parent === call ? [child] : [])),
    )
    const bug = bugSeed % count
    const wrong = wrongCalls(parents, bug)
    const nodes = parents.map((_, call) => fakeCall(call))
    const keys = groups
      .slice(0, count)
      .map((group, call) => (group === null ? null : `${wrong.has(call) ? 'w' : 'r'}${group}`))
    const unsure = new Set(unsureSeeds.map((seed) => seed % count))
    return { nodes, parents, children, bug, unsure, keys }
  })

function fakeCall(id: number): CallNode {
  return {
    id,
    entry: id,
    exit: id,
    depth: id === 0 ? 0 : 1,
    outcome: 'returned',
    protoId: 0,
    name: `f${id}`,
    library: false,
  }
}

function treeOf(s: Scenario): FinderTree {
  return {
    children: (call) => s.children[call.id]!.map((child) => s.nodes[child]!),
    keyOf: (call) => s.keys[call.id] ?? null,
  }
}

function interview(s: Scenario, oracle: (call: number) => Answer) {
  let state = startFinder(treeOf(s), s.nodes[0]!)
  const asked: number[] = []
  for (let call = question(state); call !== null; call = question(state)) {
    asked.push(call.id)
    state = answer(state, oracle(call.id))
  }
  return { state, asked, result: verdict(state) }
}

describe('the bug finder on generated call trees', () => {
  test('finds the planted bug with certainty, asking about each distinct call once', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const wrong = wrongCalls(s.parents, s.bug)
        const { result, asked } = interview(s, (call) => (wrong.has(call) ? 'wrong' : 'right'))
        expect(result).toEqual({ kind: 'found', call: s.nodes[s.bug], certainty: 'certain' })
        const keys = asked.map((call) => s.keys[call]).filter((key) => key !== null)
        expect(new Set(keys).size).toBe(keys.length)
        expect(asked.length).toBeLessThan(s.nodes.length)
      }),
    )
  })

  test('being unsure about right calls only lowers the certainty', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const wrong = wrongCalls(s.parents, s.bug)
        const oracle = (call: number): Answer =>
          wrong.has(call) ? 'wrong' : s.unsure.has(call) ? 'unsure' : 'right'
        const { result, state } = interview(s, oracle)
        const doubted = state.judgments.some(
          (judgment) => judgment.answer === 'unsure' && s.parents[judgment.call.id] === s.bug,
        )
        expect(result).toEqual({
          kind: 'found',
          call: s.nodes[s.bug],
          certainty: doubted ? 'likely' : 'certain',
        })
      }),
    )
  })

  test('being unsure about any call never points below the bug, and only certainly at it', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const wrong = wrongCalls(s.parents, s.bug)
        const oracle = (call: number): Answer =>
          s.unsure.has(call) ? 'unsure' : wrong.has(call) ? 'wrong' : 'right'
        const { result } = interview(s, oracle)
        if (result.kind !== 'found') throw new Error('the search did not end')
        expect(wrong.has(result.call.id)).toBe(true)
        if (result.certainty === 'certain') expect(result.call.id).toBe(s.bug)
      }),
    )
  })
})
