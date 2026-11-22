import { describe, expect, test } from 'vitest'
import { candidatesFor, linearText, type Observation, type Param } from './infer-templates'
import { type Plain, plainList } from './infer-values'

/** Observations of calls with these arguments and results (arguments unchanged by the call). */
function calls(rows: readonly [readonly Plain[], Plain][]): Observation[] {
  return rows.map(([args, result], i) => ({
    entry: i,
    before: args,
    after: args,
    result,
    example: `call ${i}`,
  }))
}

/** The clauses that hold in every call. */
function holding(params: readonly Param[], observations: readonly Observation[]): string[] {
  return candidatesFor(params, observations)
    .filter((c) => observations.every((o) => c.holds(o) === true))
    .map((c) => `${c.kind} ${c.clause}`)
}

const X: Param[] = [{ name: 'x', index: 0 }]
const XY: Param[] = [
  { name: 'x', index: 0 },
  { name: 'y', index: 1 },
]
const list = (...items: Plain[]) => plainList(items)

describe('candidatesFor', () => {
  test('finds numeric builtin images', () => {
    // Arrange
    const abs = calls([
      [[-2], 2],
      [[3], 3],
      [[-5], 5],
    ])
    const floor = calls([
      [[1.5], 1],
      [[2.25], 2],
      [[-0.5], -1],
    ])
    const round = calls([
      [[1.5], 2],
      [[-2.5], -3],
      [[0.2], 0],
    ])
    const ceil = calls([
      [[1.5], 2],
      [[2.25], 3],
      [[-0.5], -0],
    ])

    // Act / Assert
    expect(holding(X, abs)).toContain('ensures result == abs(x)')
    expect(holding(X, floor)).toContain('ensures result == floor(x)')
    expect(holding(X, round)).toContain('ensures result == round(x)')
    expect(holding(X, ceil)).toContain('ensures result == ceil(x)')
  })

  test('finds list and string images', () => {
    // Arrange
    const sums = calls([
      [[list(1, 2)], 3],
      [[list(5)], 5],
      [[list(2, 2, 2)], 6],
    ])
    const mins = calls([
      [[list(3, 1)], 1],
      [[list(5)], 5],
      [[list(2, 0, 4)], 0],
    ])
    const reversed = calls([
      [[list(1, 2)], list(2, 1)],
      [[list(5)], list(5)],
      [[list(3, 1, 2)], list(2, 1, 3)],
    ])
    const backwards = calls([
      [['ab'], 'ba'],
      [['xyz'], 'zyx'],
      [['q'], 'q'],
    ])
    const unique = calls([
      [[list(1, 1, 2)], list(1, 2)],
      [[list(3)], list(3)],
      [[list(2, 2)], list(2)],
    ])
    const trimmed = calls([
      [[' a '], 'a'],
      [['b  '], 'b'],
      [['c'], 'c'],
    ])
    const lowered = calls([
      [['A'], 'a'],
      [['Bc'], 'bc'],
      [['d'], 'd'],
    ])

    // Act / Assert
    expect(holding(X, sums)).toContain('ensures result == sum(x)')
    expect(holding(X, mins)).toContain('ensures result == min(x)')
    expect(holding(X, reversed)).toContain('ensures result == reverse(x)')
    expect(holding(X, backwards)).toContain('ensures result == reverse(x)')
    expect(holding(X, unique)).toContain('ensures result == uniq(x)')
    expect(holding(X, trimmed)).toContain('ensures result == trim(x)')
    expect(holding(X, lowered)).toContain('ensures result == lower(x)')
  })

  test('relates two numeric parameters by difference and product', () => {
    // Arrange
    const minus = calls([
      [[5, 2], 3],
      [[9, 1], 8],
      [[4, 4], 0],
    ])
    const backwards = calls([
      [[2, 5], 3],
      [[1, 9], 8],
      [[4, 7], 3],
    ])
    const times = calls([
      [[2, 3], 6],
      [[4, 5], 20],
      [[1, 7], 7],
    ])

    // Act / Assert
    expect(holding(XY, minus)).toContain('ensures result == x - y')
    expect(holding(XY, backwards)).toContain('ensures result == y - x')
    expect(holding(XY, times)).toContain('ensures result == x * y')
  })

  test('joins two lists in either order', () => {
    // Arrange
    const joined = calls([
      [[list(1), list(2)], list(2, 1)],
      [[list(3, 4), list()], list(3, 4)],
      [[list(), list(5)], list(5)],
    ])

    // Act / Assert
    expect(holding(XY, joined)).toContain('ensures result == y + x')
  })

  test('finds strict and non-strict orders and every sign', () => {
    // Arrange
    const below = calls([
      [[5], 4],
      [[2], 1],
      [[-1], -2],
    ])
    const atLeast = calls([
      [[5], 5],
      [[2], 3],
      [[-1], 0],
    ])
    const nonPositive = calls([
      [[0], 0],
      [[-2], -2],
      [[-1], -1],
    ])

    // Act / Assert
    expect(holding(X, below)).toEqual(expect.arrayContaining(['ensures result < x']))
    expect(holding(X, atLeast)).toEqual(
      expect.arrayContaining(['ensures result >= x', 'ensures result >= 0']),
    )
    expect(holding(X, nonPositive)).toContain('requires x <= 0')
  })

  test('fits a line with a negative factor and leaves the identity to other templates', () => {
    // Arrange
    const negative = calls([
      [[1], 7],
      [[2], 4],
      [[4], -2],
    ])
    const identity = calls([
      [[1], 1],
      [[2], 2],
      [[4], 4],
    ])
    const fractional = calls([
      [[1], 0.5],
      [[2], 1],
      [[4], 2],
    ])

    // Act / Assert
    expect(holding(X, negative)).toContain('ensures result == -3 * x + 10')
    expect(holding(X, identity).filter((c) => c.includes('*'))).toEqual([])
    expect(holding(X, fractional).filter((c) => c.includes('*'))).toEqual([])
  })

  test('needs three different sources for a line', () => {
    // Arrange
    const two = calls([
      [[1], 3],
      [[2], 5],
      [[2], 5],
    ])

    // Act / Assert
    expect(holding(X, two)).not.toContain('ensures result == 2 * x + 1')
  })

  test('picks a lambda name no parameter takes', () => {
    // Arrange
    const params: Param[] = [
      { name: 'x', index: 0 },
      { name: 'v', index: 1 },
    ]
    const subset = calls([
      [[list(1, 2), 0], list(1)],
      [[list(3), 0], list(3)],
      [[list(4, 5), 0], list()],
    ])

    // Act / Assert
    expect(holding(params, subset)).toContain('ensures all(result, |item| contains(x, item))')
  })

  test('leaves undecidable contents undecided', () => {
    // Arrange
    const opaque: Plain = { kind: 'list', length: 3, items: null }
    const observations = calls([
      [[opaque], 1],
      [[opaque], 2],
      [[opaque], 3],
    ])

    // Act
    const clauses = candidatesFor(X, observations).map((c) => c.clause)

    // Assert
    expect(clauses).not.toContain('contains(x, result)')
    expect(clauses).toContain('len(x) > 0')
  })
})

describe('linearText', () => {
  test('writes the simplest form of a * x + b', () => {
    // Arrange / Act / Assert
    expect(linearText(1, 'n', -1)).toBe('n - 1')
    expect(linearText(-1, 'n', 0)).toBe('-n')
    expect(linearText(3, 'len(xs)', 0)).toBe('3 * len(xs)')
    expect(linearText(2, 'n', 1)).toBe('2 * n + 1')
  })
})
