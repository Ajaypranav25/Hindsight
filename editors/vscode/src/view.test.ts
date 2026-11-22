import { describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../../src/core/index'
import { DEFAULT_MAX_STEPS, type Problem } from './analysis'
import {
  COMMANDS,
  inlineText,
  INLINE_TEXT_LIMIT,
  lensSpecs,
  MAX_STEPS,
  MIN_STEPS,
  problemReport,
  stepBudget,
  targetLine,
} from './view'

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program)
}

describe('code lens specs', () => {
  test('put call counts and clickable why-not lenses in line order', () => {
    // Arrange
    const source = [
      'fn check(n) {', //            1
      '  if n > 10 {', //            2
      '    print("big")', //         3
      '  }', //                      4
      '  return n', //               5
      '}', //                        6
      'print(check(3))', //          7
    ].join('\n')

    // Act
    const lenses = lensSpecs(recorded(source))

    // Assert
    expect(lenses).toEqual([
      {
        line: 1,
        title: 'ran once',
        tooltip: 'How many times the last run called check',
        command: null,
      },
      {
        line: 3,
        title: 'never ran — why not?',
        tooltip: 'Explain why the last run never reached this code',
        command: COMMANDS.whyNot,
      },
    ])
  })
})

describe('inline why-not text', () => {
  test('keeps a short sentence and flattens its whitespace', () => {
    expect(inlineText('  Line 3 never ran\n because  x was 2. ')).toBe(
      'Line 3 never ran because x was 2.',
    )
  })

  test('shortens a long sentence at a word boundary, ending in an ellipsis', () => {
    const sentence = `Line 9 never ran because ${'the condition was false again '.repeat(10)}`

    const text = inlineText(sentence)

    expect(text.length).toBeLessThanOrEqual(INLINE_TEXT_LIMIT)
    expect(text.endsWith('…')).toBe(true)
    expect(text).not.toMatch(/ …$/)
    expect(sentence.startsWith(text.slice(0, -1))).toBe(true)
  })

  test('cuts inside a word when there is no space in the second half', () => {
    expect(inlineText(`ab ${'x'.repeat(40)}`, 20)).toBe(`ab ${'x'.repeat(16)}…`)
  })
})

describe('step budget', () => {
  test('uses the default for missing or non-numeric settings', () => {
    expect(stepBudget(undefined)).toBe(DEFAULT_MAX_STEPS)
    expect(stepBudget('5000')).toBe(DEFAULT_MAX_STEPS)
    expect(stepBudget(Number.NaN)).toBe(DEFAULT_MAX_STEPS)
    expect(stepBudget(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_STEPS)
  })

  test('clamps to the declared bounds and drops fractions', () => {
    expect(stepBudget(10)).toBe(MIN_STEPS)
    expect(stepBudget(1e12)).toBe(MAX_STEPS)
    expect(stepBudget(25_000.9)).toBe(25_000)
  })
})

describe('compile-error report', () => {
  test('lists each problem with its position, then says nothing ran', () => {
    const problems: Problem[] = [
      {
        severity: 'error',
        code: 'E010',
        message: 'expected an expression',
        start: { line: 2, column: 9 },
        end: { line: 2, column: 10 },
      },
    ]

    expect(problemReport(problems, 'a.sight')).toEqual([
      '[a.sight:2:9] error E010: expected an expression',
      '[a.sight] did not compile; nothing ran',
    ])
  })
})

describe('target line', () => {
  test('prefers a valid line argument from a code lens', () => {
    expect(targetLine(4, 1, 10)).toBe(4)
  })

  test('falls back to the cursor line for missing or invalid arguments', () => {
    expect(targetLine(undefined, 3, 10)).toBe(3)
    expect(targetLine('4', 3, 10)).toBe(3)
    expect(targetLine(2.5, 3, 10)).toBe(3)
    expect(targetLine(0, 3, 10)).toBe(3)
    expect(targetLine(11, 3, 10)).toBe(3)
  })

  test('keeps the cursor line inside the document', () => {
    expect(targetLine(undefined, 0, 10)).toBe(1)
    expect(targetLine(undefined, 50, 10)).toBe(10)
    expect(targetLine(undefined, 5, 0)).toBe(1)
  })
})
