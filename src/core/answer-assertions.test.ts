import { describe, expect, test } from 'vitest'
import { answerAssertions, insertAssertions, sourceText } from './answer-assertions'
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
  startFinder,
  verdict,
} from './index'

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program, {})
}

/** A top-down interview answered with `answers`, one per question. */
function interview(source: string, answers: readonly ('right' | 'wrong')[]) {
  const recording = recorded(source)
  const tree = callTree(recording)
  let state: FinderState = startFinder(tree, tree.root, { strategy: 'top-down' })
  for (const given of answers) state = answer(state, given)
  return { recording, tree, state }
}

const AVERAGE = `fn total(xs) {
  var sum = 0
  for x in xs { sum += x }
  sum
}
fn average(xs) {
  total(xs) / (len(xs) - 1)
}
print(average([88, 83, 79]))
`

describe('answerAssertions', () => {
  test('writes the calls a person judged right as assertions', () => {
    // Arrange
    const { tree, state } = interview(AVERAGE, ['wrong', 'right'])

    // Act
    const assertions = answerAssertions(tree, state)

    // Assert
    expect(assertions.map((entry) => entry.text)).toEqual(['assert(total([88, 83, 79]) == 250)'])
    expect(assertions[0]!.call.name).toBe('total')
  })

  test('added to the program, the assertions answer those questions on the next run', () => {
    // Arrange
    const first = interview(AVERAGE, ['wrong', 'right'])
    const texts = answerAssertions(first.tree, first.state).map((entry) => entry.text)
    const source = insertAssertions(AVERAGE, texts)
    const recording = recorded(source)
    const tree = callTree(recording)
    const oracle = contractOracle(recording, tree)

    // Act
    let state = autoAnswer(startFinder(tree, tree.root, { strategy: 'top-down' }), oracle)
    while (question(state)?.name !== 'average') state = answer(state, 'right')
    state = autoAnswer(answer(state, 'wrong'), oracle)

    // Assert
    expect(source).toContain('}\n\nassert(total([88, 83, 79]) == 250)\nprint(average')
    expect(verdict(state)).toMatchObject({ kind: 'found', call: { name: 'average' } })
    expect(state.judgments.some((judgment) => judgment.auto?.answer === 'right')).toBe(true)
  })

  test('leaves out calls that could not be replayed anywhere', () => {
    // Arrange
    const source = `var scale = 2
fn scaled(n) { n * scale }
fn grow(xs) { push(xs, 1)
  len(xs) }
fn outer() {
  fn inner(n) { n }
  inner(1)
}
fn crash() { 1 / 0 }
fn named(s) { ({"if": s, "two words": 2, ok: [nil, true, -0.5]}) }
let xs = []
print(scaled(1), grow(xs), outer(), named("a \\{b\\}"), crash())
`
    const { tree, state } = interview(source, ['right', 'right', 'right', 'right', 'right'])

    // Act
    const texts = answerAssertions(tree, state).map((entry) => entry.text)

    // Assert
    expect(texts).toEqual([
      'assert(outer() == 1)',
      'assert(named("a \\{b\\}") == {"if": "a \\{b\\}", "two words": 2, ok: [nil, true, -0.5]})',
    ])
  })

  test('automatic and remembered answers are not repeated as assertions', () => {
    // Arrange
    const source = `fn sq(n) ensures result == n * n { n * n }
fn twice(n) { n * 2 }
print(sq(3), twice(2), twice(2))
`
    const recording = recorded(source)
    const tree = callTree(recording)
    const oracle = contractOracle(recording, tree)
    let state = autoAnswer(startFinder(tree, tree.root, { strategy: 'top-down' }), oracle)
    state = answer(state, 'right')

    // Act
    const texts = answerAssertions(tree, state).map((entry) => entry.text)

    // Assert
    expect(texts).toEqual(['assert(twice(2) == 4)'])
  })
})

describe('insertAssertions', () => {
  test('goes after the last top-level function, or first when there is none', () => {
    expect(insertAssertions('fn f() { 1 }\nprint(f())\n', ['assert(f() == 1)'])).toBe(
      'fn f() { 1 }\n\nassert(f() == 1)\nprint(f())\n',
    )
    expect(insertAssertions('print(1)\n', ['assert(true == true)'])).toBe(
      'assert(true == true)\n\nprint(1)\n',
    )
    expect(insertAssertions('fn f() { 1 }', ['assert(f() == 1)'])).toBe(
      'fn f() { 1 }\n\nassert(f() == 1)\n',
    )
    expect(insertAssertions('print(1)\n', [])).toBe('print(1)\n')
  })
})

describe('sourceText', () => {
  test('writes plain data and refuses everything else', () => {
    // Arrange
    const recording = recorded(
      'let v = [1, "x", {a: [true]}]\nlet deep = [[[[[[[[[1]]]]]]]]]\nlet r = 1..3\nprint(v)\n',
    )
    const globals = recording.stateAt(recording.length).globals
    const value = (name: string) => globals.find((global) => global.name === name)!.value

    // Act / Assert
    expect(sourceText(recording, recording.length, value('v'))).toBe('[1, "x", {a: [true]}]')
    expect(sourceText(recording, recording.length, value('deep'))).toBeNull()
    expect(sourceText(recording, recording.length, value('r'))).toBeNull()
    expect(sourceText(recording, recording.length, { kind: 'number', value: NaN })).toBeNull()
    expect(
      sourceText(recording, recording.length, { kind: 'string', value: 'x'.repeat(300) }),
    ).toBe(null)
  })
})
