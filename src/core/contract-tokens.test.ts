import { describe, expect, test } from 'vitest'
import { contractKeywordStarts } from './contract-tokens'
import { lex } from './lexer'

/** The contract keywords of `source`, as `word@offset`. */
function keywords(source: string): string[] {
  const starts = contractKeywordStarts(lex(source).tokens)
  return [...starts].sort((a, b) => a - b).map((at) => `${source.slice(at, at + 8).trim()}@${at}`)
}

describe('contract keywords in the token stream', () => {
  test('clauses after the parameters of a declaration are keywords', () => {
    // Arrange
    const source = 'fn f(x) requires x > 0 ensures result > x { x }'

    // Act / Assert
    expect(keywords(source)).toEqual(['requires@8', 'ensures@23'])
  })

  test('clauses on their own lines, and in anonymous functions', () => {
    // Arrange
    const source = 'let g = fn(n)\n  requires n >= 0\n  ensures result >= n\n{ n }'

    // Act / Assert
    expect(keywords(source)).toEqual(['requires@16', 'ensures@34'])
  })

  test('the words are plain names everywhere else', () => {
    // Arrange
    const source =
      'let requires = 1\nfn requires_more(ensures) { ensures + requires }\nprint({requires: 2}.requires)'

    // Act / Assert
    expect(keywords(source)).toEqual([])
  })

  test('a name requires inside a clause is not a keyword', () => {
    // Arrange
    const source = 'fn f(requires) requires requires > 0 { requires }'

    // Act / Assert
    expect(keywords(source)).toEqual(['requires@15'])
  })

  test('a record literal at the start of a clause does not end it', () => {
    // Arrange
    const source = 'fn f(x) requires {a: x}.a == x ensures true { x }'

    // Act / Assert
    expect(keywords(source)).toEqual(['requires@8', 'ensures@31'])
  })

  test('brackets inside a clause hide words and braces', () => {
    // Arrange
    const source = 'fn f(xs) requires all(xs, |x| x > 0) ensures len(result) == len(xs) { xs }'

    // Act / Assert
    expect(keywords(source)).toEqual(['requires@9', 'ensures@37'])
  })

  test('functions inside a clause have their own clauses', () => {
    // Arrange
    const source = 'fn f(g) requires g(fn(y) requires y { y }) { 1 }'

    // Act / Assert
    expect(keywords(source)).toEqual(['requires@8', 'requires@25'])
  })

  test('unfinished code never throws', () => {
    // Arrange
    const sources = [
      'fn',
      'fn f(',
      'fn f(x) requires',
      'fn f(x) requires (x',
      'fn f(x) requires x)',
    ]

    // Act / Assert
    for (const source of sources) expect(() => keywords(source)).not.toThrow()
    expect(keywords('fn f(x) requires')).toEqual(['requires@8'])
  })
})
