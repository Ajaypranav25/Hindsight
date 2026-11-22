import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  autoAnswer,
  callTree,
  compile,
  contractOracle,
  exploreSchedules,
  record,
  run,
  startFinder,
  type Strategy,
  verdict,
  verifyProgram,
} from '../src/core/index'
import { parseExample } from '../src/studio/examples'

const dir = fileURLToPath(new URL('../examples/', import.meta.url))
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sight'))
  .sort()

describe('gallery examples', () => {
  test.each(files)('%s compiles and ends as its header says', (file) => {
    // Arrange
    const source = readFileSync(`${dir}${file}`, 'utf8')
    const example = parseExample(`/examples/${file}`, source)

    // Act
    const compiled = compile(source)
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics, null, 2))
    expect(verifyProgram(compiled.program)).toEqual([])
    const result = run(compiled.program, { maxSteps: 2_000_000 })

    // Assert
    const outcome = result.outcome.kind === 'error' ? 'error' : result.outcome.kind
    expect(outcome, JSON.stringify(result.outcome)).toBe(example.outcome)
    expect(result.outputs.length).toBeGreaterThan(0)
    expect(result.steps).toBeLessThan(400_000)
  })

  test.each(files)('%s records to the same output it runs to', (file) => {
    const source = readFileSync(`${dir}${file}`, 'utf8')
    const compiled = compile(source)
    if (!compiled.ok) throw new Error('compile failed')
    const fast = run(compiled.program)
    const recording = record(compiled.program)
    expect(recording.outputs.map((o) => o.text)).toEqual(fast.outputs.map((o) => o.text))
    expect(recording.length).toBe(fast.steps)
    expect(recording.stateAt(recording.length).time).toBe(recording.length)
  })

  test('the gallery prints what the summaries promise', () => {
    const output = (name: string) => {
      const source = readFileSync(`${dir}${name}`, 'utf8')
      const compiled = compile(source)
      if (!compiled.ok) throw new Error('compile failed')
      return run(compiled.program).outputs.map((o) => o.text)
    }
    expect(output('01-hello.sight')).toEqual([
      'Hello from Hindsight!',
      'Nice to meet you, Ada.',
      'Nice to meet you, Grace!',
      'Nice to meet you, Linus!',
      '1 + 2 + ... + 10 = 55',
    ])
    expect(output('03-fibonacci.sight').at(-1)).toBe('fib(10) = 55')
    expect(output('04-closures.sight')).toEqual(['1', '2', '101', '3'])
    expect(output('05-bubble-sort.sight')).toEqual(['[1, 2, 3, 4, 5, 8]'])
    expect(output('06-quicksort.sight')).toEqual(['[4, 8, 15, 16, 23, 33, 42]'])
    expect(output('07-pattern-matching.sight')).toEqual([
      'nothing',
      'zero',
      'a small number',
      'the number 42',
      'an empty string',
      'an empty list',
      'a list with just 9',
      'a list starting with 1 and 2 more',
      'Ada, aged 36',
      'something else: "hello"',
    ])
    expect(output('09-maze.sight')[0]).toBe('shortest path: 14 steps')
    expect(output('12-hanoi.sight').at(-1)).toBe('{A: [], B: [], C: [3, 2, 1]}')
    expect(output('15-linked-list.sight')).toEqual(['1 -> 2 -> 3 -> 4', '4 -> 3 -> 2 -> 1'])
    expect(output('16-pipelines.sight')).toEqual([
      'revenue: 134',
      'ada: 85',
      'linus: 8',
      'grace: 41',
    ])
    expect(output('19-contracts.sight')).toEqual(['subtotal: 55'])
    expect(output('20-producer-consumer.sight')).toEqual([
      'sum of squares: 91',
      'worker a squared 4, worker b squared 2',
    ])
    expect(output('21-bank-race.sight')).toEqual(['alice 100, bob 100, total 200'])
    expect(output('22-dining-philosophers.sight')).toEqual([
      'philosopher 0 picked up the left fork',
      'philosopher 1 picked up the left fork',
      'philosopher 2 picked up the left fork',
    ])
  })

  test('the bank race loses money under some random schedules, and the finder names the accounts', () => {
    const compiled = compile(readFileSync(`${dir}21-bank-race.sight`, 'utf8'))
    if (!compiled.ok) throw new Error('compile failed')
    const found = exploreSchedules(compiled.program, { runs: 10 })
    expect(found.groups.length).toBeGreaterThan(1)
    expect(found.divergence?.candidates.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(['accounts.alice', 'accounts.bob']),
    )
  })

  test('the philosophers deadlock with every wait in the hint', () => {
    const compiled = compile(readFileSync(`${dir}22-dining-philosophers.sight`, 'utf8'))
    if (!compiled.ok) throw new Error('compile failed')
    const { outcome } = run(compiled.program)
    expect(outcome.kind === 'error' && outcome.error.code).toBe('R028')
    expect(outcome.kind === 'error' && outcome.error.hint?.split('; ')).toHaveLength(4)
  })

  test.each<Strategy>(['divide', 'top-down'])(
    'in 19-contracts the bug finder names total with no questions (%s)',
    (strategy) => {
      // Arrange
      const compiled = compile(readFileSync(`${dir}19-contracts.sight`, 'utf8'))
      if (!compiled.ok) throw new Error('compile failed')
      const recording = record(compiled.program)
      const tree = callTree(recording)

      // Act
      const start = startFinder(tree, tree.root, { justMyCode: true, strategy })
      const state = autoAnswer(start, contractOracle(recording, tree))

      // Assert
      expect(verdict(state)).toMatchObject({
        kind: 'found',
        certainty: 'certain',
        call: { name: 'total' },
      })
      expect(state.asked).toBe(0)
    },
  )
})
