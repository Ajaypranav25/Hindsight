import { describe, expect, test } from 'vitest'
import { fnFunctions, insertContracts } from './infer-insert'
import { compile } from './index'
import { parse } from './parser'

function startOf(source: string, name: string): number {
  return source.indexOf(`fn ${name}`)
}

describe('insertContracts', () => {
  test('puts each clause on its own line and opens the body on the next', () => {
    // Arrange
    const source = 'fn average(xs) { sum(xs) / len(xs) }\nprint(average([1, 2]))\n'

    // Act
    const inserted = insertContracts(source, [
      {
        functionStart: 0,
        clauses: [
          { kind: 'requires', text: 'len(xs) > 0' },
          { kind: 'ensures', text: 'result <= max(xs)' },
        ],
      },
    ])

    // Assert
    expect(inserted.source).toBe(
      'fn average(xs)\n  requires len(xs) > 0\n  ensures result <= max(xs)\n{ sum(xs) / len(xs) }\nprint(average([1, 2]))\n',
    )
    expect(compile(inserted.source).ok).toBe(true)
    expect(inserted.missing).toEqual([])
  })

  test('reports where every clause expression landed', () => {
    // Arrange
    const source = 'fn f(x) { x }\nfn g(y) { y }\n'

    // Act
    const inserted = insertContracts(source, [
      { functionStart: startOf(source, 'g'), clauses: [{ kind: 'requires', text: 'y > 0' }] },
      { functionStart: 0, clauses: [{ kind: 'ensures', text: 'result == x' }] },
    ])

    // Assert
    const texts = inserted.placed.map((p) => inserted.source.slice(p.start, p.end))
    expect(texts).toEqual(['result == x', 'y > 0'])
    expect(inserted.placed.map((p) => p.index)).toEqual([0, 0])
  })

  test('adds after the existing clauses with their indentation', () => {
    // Arrange
    const source = 'fn f(x)\n    requires x > 0\n{\n  x\n}\n'

    // Act
    const inserted = insertContracts(source, [
      { functionStart: 0, clauses: [{ kind: 'ensures', text: 'result == x' }] },
    ])

    // Assert
    expect(inserted.source).toBe(
      'fn f(x)\n    requires x > 0\n    ensures result == x\n{\n  x\n}\n',
    )
  })

  test('indents the clauses of a nested function under its own line', () => {
    // Arrange
    const source = 'fn outer() {\n  fn inner(n) { n + 1 }\n  inner(1)\n}\n'

    // Act
    const inserted = insertContracts(source, [
      { functionStart: startOf(source, 'inner'), clauses: [{ kind: 'requires', text: 'n >= 0' }] },
    ])

    // Assert
    expect(inserted.source).toContain('  fn inner(n)\n    requires n >= 0\n  { n + 1 }')
    expect(compile(inserted.source).ok).toBe(true)
  })

  test('keeps a comment between the header and the body in place', () => {
    // Arrange
    const source = 'fn f(x) // the identity\n{\n  x\n}\n'

    // Act
    const inserted = insertContracts(source, [
      { functionStart: 0, clauses: [{ kind: 'ensures', text: 'result == x' }] },
    ])

    // Assert
    expect(inserted.source).toBe('fn f(x)\n  ensures result == x // the identity\n{\n  x\n}\n')
    expect(compile(inserted.source).ok).toBe(true)
  })

  test('names additions whose function is not a fn with a block body', () => {
    // Arrange
    const source = 'let g = |x| x + 1\nfn f(x) { x }\n'

    // Act
    const inserted = insertContracts(source, [
      { functionStart: 0, clauses: [{ kind: 'requires', text: 'x > 0' }] },
      { functionStart: startOf(source, 'f'), clauses: [] },
    ])

    // Assert
    expect(inserted.missing).toEqual([0])
    expect(inserted.source).toBe(source)
    expect(inserted.placed).toEqual([])
  })
})

describe('fnFunctions', () => {
  test('finds declarations and fn expressions at any depth but no lambdas', () => {
    // Arrange
    const source = 'fn a() { let b = fn(x) { x }\n b(1) }\nlet c = |y| { y }\n'

    // Act
    const found = fnFunctions(parse(source).program)

    // Assert
    expect([...found.keys()].sort((x, y) => x - y)).toEqual([0, source.indexOf('fn(x)')])
  })
})
