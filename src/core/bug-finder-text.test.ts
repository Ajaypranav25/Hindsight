import { describe, expect, test } from 'vitest'
import {
  callSignature,
  changeTexts,
  culpritText,
  linesText,
  outcomeText,
  questionText,
  verdictReason,
} from './bug-finder-text'
import { callTree } from './calls'
import { compile, record } from './index'

function treeOf(source: string, maxSteps?: number) {
  const result = compile(source)
  if (!result.ok) throw new Error('compile failed')
  return callTree(record(result.program, { maxSteps }))
}

const AVERAGE =
  'fn average(xs) {\n  var t = 0\n  for x in xs { t += x }\n  t / 2\n}\nprint(average([88, 83, 79]))\n'

describe('bug finder texts', () => {
  test('a question names the call, its arguments and what it returned', () => {
    const tree = treeOf(AVERAGE)
    const details = tree.details(tree.children(tree.root)[0]!)
    expect(callSignature(details)).toBe('average(xs = [88, 83, 79])')
    expect(outcomeText(details)).toBe('returned 125')
    expect(questionText(details)).toBe('average(xs = [88, 83, 79]) returned 125. Is that right?')
    expect(culpritText(details)).toBe('average (lines 1–5)')
    expect(culpritText(tree.details(tree.root))).toBe('the top-level code (lines 1–6)')
    expect(callSignature(tree.details(tree.root))).toBe('the top-level code')
  })

  test('changed arguments, errors and unfinished calls', () => {
    const changed = treeOf('fn add(xs) {\n  push(xs, 1)\n}\nlet ys = [5]\nadd(ys)\n')
    const add = changed.details(changed.children(changed.root)[0]!)
    expect(changeTexts(add)).toEqual(['xs became [5, 1]'])
    expect(questionText(add)).toBe(
      'add(xs = [5]) returned nil and changed: xs became [5, 1]. Is that right?',
    )
    const raised = treeOf('fn get(xs) {\n  xs[3]\n}\nget([1])\n')
    expect(outcomeText(raised.details(raised.children(raised.root)[0]!))).toMatch(
      /^raised an error: .+ \(R\d{3}\)$/,
    )
    const spin = treeOf('fn spin() {\n  while true {}\n}\nspin()\n', 100)
    expect(outcomeText(spin.details(spin.children(spin.root)[0]!))).toBe(
      'was still running when the recording stopped',
    )
  })

  test('line spans and verdict reasons', () => {
    expect(linesText({ start: 2, end: 2 })).toBe('line 2')
    expect(linesText({ start: 6, end: 9 })).toBe('lines 6–9')
    const tree = treeOf(AVERAGE)
    const details = tree.details(tree.children(tree.root)[0]!)
    expect(verdictReason(details, 'certain', 2)).toBe(
      'Every call it makes returned the right value, but its own result is wrong.',
    )
    expect(verdictReason(details, 'certain', 0)).toBe(
      'It makes no calls of its own, and its own result is wrong.',
    )
    expect(verdictReason(details, 'likely', 2)).toMatch(
      /^None of the calls .+ may be in one of them\.$/,
    )
    expect(verdictReason(tree.details(tree.root), 'certain', 1)).toBe(
      'Every call it makes returned the right value, so the mistake is in its own statements.',
    )
  })
})
