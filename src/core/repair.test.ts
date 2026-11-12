import { describe, expect, test } from 'vitest'
import { answer, question, startFinder, verdict } from './bug-finder'
import { callTree } from './calls'
import { compile, record, type Recording } from './index'
import { repairExamples, type RepairRequest, type RepairResult, repairSearch } from './repair'

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program)
}

function repairs(recording: Recording, request: RepairRequest, maxMutants?: number): RepairResult {
  const search = repairSearch({ compile, record }, recording, request, { maxMutants })
  let next = search.next()
  while (next.done !== true) next = search.next()
  return next.value
}

const AVERAGE =
  'fn total(scores) {\n  var sum = 0\n  for s in scores { sum += s }\n  sum\n}\n' +
  'fn average(scores) {\n  total(scores) / (len(scores) + 1)\n}\n' +
  'print(average([90, 80, 100]))\n'

/** Interviews the finder: `average` is wrong, everything else is right. */
function interviewed(recording: Recording) {
  const tree = callTree(recording)
  let state = startFinder(tree, tree.root)
  for (let call = question(state); call !== null; call = question(state)) {
    state = answer(state, call.name === 'average' ? 'wrong' : 'right')
  }
  const found = verdict(state)
  if (found.kind !== 'found') throw new Error('no verdict')
  return { tree, state, culprit: found.call }
}

describe('repair previews', () => {
  test('the interview gives the examples a repair is checked against', () => {
    const { tree, state } = interviewed(recorded(AVERAGE))
    expect(repairExamples(tree, state)).toEqual([
      { name: 'average', args: ['[90, 80, 100]'], did: 'returned 67.5', answer: 'wrong' },
      { name: 'total', args: ['[90, 80, 100]'], did: 'returned 270', answer: 'right' },
    ])
  })

  test('finds the one-token change, and shows what the wrong call does with it', () => {
    const recording = recorded(AVERAGE)
    const { tree, state, culprit } = interviewed(recording)
    const result = repairs(recording, {
      kind: 'examples',
      protoId: culprit.protoId,
      examples: repairExamples(tree, state),
    })
    expect(result.problem).toBeNull()
    // Only `average` (line 7) is changed: `total` was judged right and is not the culprit.
    expect(new Set(result.repairs.map((repair) => repair.line))).toEqual(new Set([7]))
    const fix = result.repairs.find((repair) => repair.change === '`1` → `0`')
    expect(fix).toMatchObject({
      before: '  total(scores) / (len(scores) + 1)',
      after: '  total(scores) / (len(scores) + 0)',
      now: ['average(scores = [90, 80, 100]) now returned 90'],
    })
    // The repaired program is whole and runs.
    const repaired = recorded(fix!.source)
    expect(repaired.outputs.map((output) => output.text)).toEqual(['90'])
  })

  test('a repair must keep the calls judged right', () => {
    // `double` is right for 2 but the caller is wrong: mutating inside `twice` must not break
    // the judged-right call of `double`.
    const source = 'fn double(n) { n + n }\nfn twice(n) { double(n) - 1 }\nprint(twice(2))\n'
    const recording = recorded(source)
    const { tree, state, culprit } = interviewed2(recording, 'twice')
    const result = repairs(recording, {
      kind: 'examples',
      protoId: culprit.protoId,
      examples: repairExamples(tree, state),
    })
    expect(result.repairs.length).toBeGreaterThan(0)
    for (const repair of result.repairs) expect(repair.line).toBe(2)
    expect(result.repairs.map((repair) => repair.change)).toContain('`1` → `0`')
  })

  test('a crash: the function it happened in is changed until the run finishes', () => {
    const source = 'fn last(xs) {\n  xs[len(xs)]\n}\nprint(last([4, 5, 6]))\n'
    const recording = recorded(source)
    const result = repairs(recording, { kind: 'crash' })
    expect(result.repairs.map((repair) => `${repair.line}: ${repair.after.trim()}`)).toEqual([])
    const off = recorded('fn last(xs) {\n  xs[len(xs) - 0]\n}\nprint(last([4, 5, 6]))\n')
    const fixed = repairs(off, { kind: 'crash' })
    expect(fixed.repairs.map((repair) => repair.after.trim())).toEqual(['xs[len(xs) - 1]'])
    expect(fixed.repairs.map((repair) => repair.now)).toContainEqual(['the run finishes'])
  })

  test('says when there is nothing to try', () => {
    const fine = recorded('print(1)\n')
    expect(repairs(fine, { kind: 'crash' }).problem).toContain('did not crash')
    expect(
      repairs(fine, { kind: 'examples', protoId: fine.program.script.id, examples: [] }).problem,
    ).toContain('no call judged wrong')
    const bare = recorded('fn f(x) { x }\nprint(f(nil))\n')
    const none = repairs(bare, {
      kind: 'examples',
      protoId: bare.program.protos[1]!.id,
      examples: [{ name: 'f', args: ['nil'], did: 'returned nil', answer: 'wrong' }],
    })
    expect(none.problem).toContain('no operator or number')
  })

  test('the budget stops the search', () => {
    const recording = recorded(AVERAGE)
    const { tree, state, culprit } = interviewed(recording)
    const request = {
      kind: 'examples',
      protoId: culprit.protoId,
      examples: repairExamples(tree, state),
    } as const
    expect(repairs(recording, request, 1)).toMatchObject({ tried: 1, exhausted: true })
  })
})

function interviewed2(recording: Recording, wrong: string) {
  const tree = callTree(recording)
  let state = startFinder(tree, tree.root)
  for (let call = question(state); call !== null; call = question(state)) {
    state = answer(state, call.name === wrong ? 'wrong' : 'right')
  }
  const found = verdict(state)
  if (found.kind !== 'found') throw new Error('no verdict')
  return { tree, state, culprit: found.call }
}
