/**
 * Contract keywords in a token stream (SPEC §2.4, §3.1), for editors that highlight from the lexer.
 * `requires` and `ensures` are identifiers to the lexer; they are keywords only between a `fn`'s
 * parameter list and its body: right after the `)`, or right after a complete clause expression.
 * One linear pass with explicit counters (no recursion), and it never throws, whatever the tokens.
 */
import type { Token, TokenKind } from './tokens'

const OPENERS: ReadonlySet<TokenKind> = new Set<TokenKind>(['(', '[', '{', 'StringHead'])
const CLOSERS: ReadonlySet<TokenKind> = new Set<TokenKind>([')', ']', '}', 'StringTail'])
/** Tokens that can end an operand: after one, a `{` begins the body and a word a new clause. */
const OPERAND_ENDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'Identifier',
  'Number',
  'String',
  'StringTail',
  ')',
  ']',
  '}',
  'true',
  'false',
  'nil',
])

function isContractWord(token: Token | undefined): boolean {
  return token?.kind === 'Identifier' && (token.value === 'requires' || token.value === 'ensures')
}

/** The index just past the `)` matching the `(` at `open`, or -1 when it never closes. */
function afterClosingParen(tokens: readonly Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    const kind = tokens[i]!.kind
    if (OPENERS.has(kind)) depth++
    else if (CLOSERS.has(kind) && --depth === 0) return i + 1
  }
  return -1
}

/**
 * Marks the contract keywords of the function header whose parameter list ends just before
 * `start`; returns nothing (marks go into `found`).
 */
function markClauses(tokens: readonly Token[], start: number, found: Set<number>): void {
  let i = start
  while (isContractWord(tokens[i])) {
    found.add(tokens[i]!.start)
    i++
    // The clause expression: up to a `{` or a contract word that follows a complete operand.
    const first = i
    let depth = 0
    for (; i < tokens.length; i++) {
      const token = tokens[i]!
      if (token.kind === 'EOF') return
      const ended = depth === 0 && i > first && OPERAND_ENDS.has(tokens[i - 1]!.kind)
      if (ended && (token.kind === '{' || isContractWord(token))) break
      if (OPENERS.has(token.kind)) depth++
      else if (CLOSERS.has(token.kind)) depth--
      if (depth < 0) return
    }
  }
}

/** The start offsets of the tokens that are contract keywords. */
export function contractKeywordStarts(tokens: readonly Token[]): ReadonlySet<number> {
  const found = new Set<number>()
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.kind !== 'fn') continue
    let open = i + 1
    if (tokens[open]?.kind === 'Identifier') open++
    if (tokens[open]?.kind !== '(') continue
    const after = afterClosingParen(tokens, open)
    if (after >= 0) markClauses(tokens, after, found)
  }
  return found
}
