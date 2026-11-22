import { describe, expect, test } from 'vitest'
import { compile, record } from '../../core/index'
import { compareValues, evaluatePrediction, MAX_PREDICTION_LENGTH, type ValueAt } from './values'

function value(text: string): ValueAt {
  const predicted = evaluatePrediction(text)
  if (!predicted.ok) throw new Error(`not a value: ${text}: ${predicted.error}`)
  return predicted.at
}

function compare(a: string, b: string) {
  return compareValues(value(a), value(b))
}

describe('evaluatePrediction', () => {
  test('evaluates literals and small expressions in the VM and shows them as repr does', () => {
    // Arrange
    const texts = ['91.66666666666667', '"text"', 'nil', '[1, 2, [3]]', '{a: 1}', '7 / 2']

    // Act
    const shown = texts.map((text) => {
      const predicted = evaluatePrediction(text)
      return predicted.ok ? predicted.text : predicted.error
    })

    // Assert
    expect(shown).toEqual(['91.66666666666667', '"text"', 'nil', '[1, 2, [3]]', '{a: 1}', '3.5'])
  })

  test('refuses what is not one expression, fails, runs too long or is too long', () => {
    // Arrange
    const texts = [
      '',
      'let x = 1',
      '1\n2',
      'nope_name',
      '1 / 0',
      'sum(range(10000000))',
      'x'.repeat(MAX_PREDICTION_LENGTH + 1),
      '(',
    ]

    // Act
    const errors = texts.map((text) => {
      const predicted = evaluatePrediction(text)
      return predicted.ok ? 'ok' : predicted.error
    })

    // Assert
    expect(errors[0]).toBe('it is empty')
    expect(errors[1]).toBe('it is not one Hindsight expression')
    expect(errors[2]).toBe('it is not one Hindsight expression')
    expect(errors[3]).toMatch(/nope_name/)
    expect(errors[4]).toMatch(/zero/i)
    expect(errors[5]).toBe('it takes too long to evaluate')
    expect(errors[6]).toBe('it is too long')
    expect(errors[7]).toBe('it is not one Hindsight expression')
  })
})

describe('compareValues', () => {
  test('numbers are equal within a small relative or absolute tolerance', () => {
    // Arrange, Act, Assert
    expect(compare('275', '275')).toBe('equal')
    expect(compare('91.66666666666667', '275 / 3')).toBe('equal')
    expect(compare('0.1 + 0.2', '0.3')).toBe('equal')
    expect(compare('1e-15', '0')).toBe('equal')
    expect(compare('91.6', '91.66666666666667')).toBe('different')
    expect(compare('0 / 1 - 1', '-1')).toBe('equal')
  })

  test('primitives compare by type and value', () => {
    // Arrange, Act, Assert
    expect(compare('"a"', '"a"')).toBe('equal')
    expect(compare('"a"', '"b"')).toBe('different')
    expect(compare('nil', 'false')).toBe('different')
    expect(compare('nil', 'nil')).toBe('equal')
    expect(compare('true', 'true')).toBe('equal')
    expect(compare('1', '"1"')).toBe('different')
    expect(compare('[1]', '{a: 1}')).toBe('different')
  })

  test('lists compare item by item, records by key whatever the order', () => {
    // Arrange, Act, Assert
    expect(compare('[1, [2, 3]]', '[1, [2, 3.0000000000001]]')).toBe('equal')
    expect(compare('[1, 2]', '[1, 2, 3]')).toBe('different')
    expect(compare('[1, 2]', '[1, 3]')).toBe('different')
    expect(compare('{a: 1, b: [2]}', '{b: [2], a: 1}')).toBe('equal')
    expect(compare('{a: 1}', '{b: 1}')).toBe('different')
    expect(compare('{a: 1}', '{a: 1, b: 2}')).toBe('different')
    expect(compare('range(500)', 'range(500)')).toBe('equal')
    expect(compare('range(500)', 'range(501)')).toBe('different')
    expect(compare('range(600) |> map(|x| x)', 'range(600) |> map(|x| x)')).toBe('equal')
  })

  test('functions cannot be compared across runs; a difference elsewhere still decides', () => {
    // Arrange, Act, Assert
    expect(compare('|x| x', '|x| x')).toBe('unknown')
    expect(compare('[|x| x, 1]', '[|x| x, 2]')).toBe('different')
    expect(compare('[|x| x, 1]', '[|x| x, 1]')).toBe('unknown')
  })

  test('values too large to compare are unknown', () => {
    // Arrange
    const big = recordedGlobal('let xs = range(30000) |> map(|x| x)\n', 'xs')

    // Act
    const result = compareValues(big, big)

    // Assert
    expect(result).toBe('unknown')
  })

  test('a cyclic value is equal to itself', () => {
    // Arrange
    const cyclic = recordedGlobal('let xs = [1]\npush(xs, xs)\n', 'xs')

    // Act
    const result = compareValues(cyclic, cyclic)

    // Assert
    expect(result).toBe('equal')
  })
})

/** A global's value at the end of a run (values larger than a prediction may build). */
function recordedGlobal(source: string, name: string): ValueAt {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('compile failed')
  const recording = record(compiled.program)
  const time = recording.length
  const global = recording.stateAt(time).globals.find((candidate) => candidate.name === name)!
  return { recording, time, value: global.value }
}
