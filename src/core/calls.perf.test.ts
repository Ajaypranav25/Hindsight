import { expect, test } from 'vitest'
import { answer, question, startFinder } from './bug-finder'
import { callTree } from './calls'
import { recordSource } from './testing/recording'

/**
 * Performance budget for the bug finder (ARCHITECTURE §7.6), with generous bounds for slow CI
 * machines: indexing the calls of a million-step recording takes a few milliseconds on a typical
 * machine, and a question needs only two seeks.
 */
const INDEX_BUDGET_MS = 300
const QUESTION_BUDGET_MS = 50

test('the call tree of a million-step recording is indexed and questioned quickly', () => {
  const source = `fn step(x) { x + 1 }
fn work(n) {
  var total = 0
  var i = 0
  while i < n {
    total = total + step(i) % 7
    i += 1
  }
  total
}
print(work(50000))`
  const recording = recordSource(source)
  expect(recording.length).toBeGreaterThan(1_000_000)

  const started = performance.now()
  const tree = callTree(recording)
  const work = tree.children(tree.root, { justMyCode: true })[0]!
  const calls = tree.children(work, { justMyCode: true })
  const indexed = performance.now() - started
  expect(calls).toHaveLength(50_000)
  expect(indexed).toBeLessThan(INDEX_BUDGET_MS)

  let state = answer(startFinder(tree, tree.root), 'wrong')
  const asking = performance.now()
  for (let i = 0; i < 20; i++) state = answer(state, 'right')
  const perQuestion = (performance.now() - asking) / 20
  expect(question(state)?.name).toBe('step')
  expect(perQuestion).toBeLessThan(QUESTION_BUDGET_MS)
})
