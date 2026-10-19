/** Pure syntax classification driven by the real lexer (no CodeMirror imports). */
import { lex, type Token } from '../../core/index'
import { BUILTIN_NAMES } from '../../core/builtin-names'

export type SyntaxClass =
  'keyword' | 'atom' | 'number' | 'string' | 'interp' | 'builtin' | 'ident' | 'punct' | 'comment'

export interface StyledRange {
  readonly from: number
  readonly to: number
  readonly cls: SyntaxClass
}

const BUILTINS: ReadonlySet<string> = new Set(BUILTIN_NAMES)
const ATOMS: ReadonlySet<string> = new Set(['true', 'false', 'nil'])
const KEYWORD_KIND = /^[a-z]+$/

/** The class of a whole token (string pieces are split further by `tokenRanges`). */
export function classifyToken(token: Token): SyntaxClass | null {
  const kind = token.kind
  switch (kind) {
    case 'EOF':
      return null
    case 'Number':
      return 'number'
    case 'String':
    case 'StringHead':
    case 'StringMiddle':
    case 'StringTail':
      return 'string'
    case 'Identifier':
      return BUILTINS.has(String(token.value)) ? 'builtin' : 'ident'
    default:
      if (ATOMS.has(kind)) return 'atom'
      return KEYWORD_KIND.test(kind) ? 'keyword' : 'punct'
  }
}

/** Ranges for one token: the interpolation braces of string pieces get their own class. */
export function tokenRanges(token: Token): StyledRange[] {
  const cls = classifyToken(token)
  if (cls === null || token.end <= token.start) return []
  const { start, end, kind } = token
  const opensBrace = kind === 'StringHead' || kind === 'StringMiddle'
  const closesBrace = kind === 'StringMiddle' || kind === 'StringTail'
  if (!opensBrace && !closesBrace) return [{ from: start, to: end, cls }]
  const ranges: StyledRange[] = []
  const textFrom = closesBrace ? start + 1 : start
  // An unterminated piece at end of file has no closing brace or quote to split off.
  const opens = opensBrace && end - 1 >= textFrom
  const textTo = opens ? end - 1 : end
  if (closesBrace) ranges.push({ from: start, to: start + 1, cls: 'interp' })
  if (textTo > textFrom) ranges.push({ from: textFrom, to: textTo, cls: 'string' })
  if (opens) ranges.push({ from: end - 1, to: end, cls: 'interp' })
  return ranges
}

function commentRange(span: { start: number; end: number }): StyledRange[] {
  return span.end > span.start ? [{ from: span.start, to: span.end, cls: 'comment' }] : []
}

/** Every styled range of `source`, sorted by position (tokens and comments merged). */
export function highlightRanges(source: string): StyledRange[] {
  const { tokens, comments } = lex(source)
  const ranges: StyledRange[] = []
  let c = 0
  for (const token of tokens) {
    while (c < comments.length && comments[c]!.start <= token.start)
      ranges.push(...commentRange(comments[c++]!))
    ranges.push(...tokenRanges(token))
  }
  for (; c < comments.length; c++) ranges.push(...commentRange(comments[c]!))
  return ranges
}

/** The identifier token containing `pos` (its end included), or null. */
export function identifierAt(source: string, pos: number): Token | null {
  for (const token of lex(source).tokens) {
    if (token.start > pos) return null
    if (token.kind === 'Identifier' && pos >= token.start && pos <= token.end) return token
  }
  return null
}
