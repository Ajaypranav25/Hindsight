/** Reserved words (docs/SPEC.md §2.4). */
export const KEYWORDS = [
  'and',
  'break',
  'continue',
  'else',
  'false',
  'fn',
  'for',
  'if',
  'in',
  'let',
  'match',
  'nil',
  'not',
  'or',
  'return',
  'true',
  'var',
  'while',
] as const

export type Keyword = (typeof KEYWORDS)[number]

/** Punctuators in longest-match-first order (docs/SPEC.md §2.7). */
export const PUNCTUATORS = [
  '...',
  '..=',
  '..',
  '.',
  '=>',
  '==',
  '=',
  '!=',
  '<=',
  '<',
  '>=',
  '>',
  '+=',
  '+',
  '-=',
  '-',
  '**',
  '*=',
  '*',
  '/=',
  '/',
  '%=',
  '%',
  '|>',
  '|',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ',',
  ':',
  ';',
] as const

export type Punctuator = (typeof PUNCTUATORS)[number]

export type LiteralKind =
  'Number' | 'String' | 'StringHead' | 'StringMiddle' | 'StringTail' | 'Identifier' | 'EOF'

/** Keyword and punctuator kinds are their literal text, e.g. `'let'` or `'..='`. */
export type TokenKind = Keyword | Punctuator | LiteralKind

export interface Token {
  readonly kind: TokenKind
  readonly start: number
  readonly end: number
  /** True when a line terminator separates this token from the previous one (§2.3). */
  readonly newlineBefore: boolean
  /** Number value for `Number`; cooked text for string kinds; the name for `Identifier`. */
  readonly value?: number | string
}

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS)

export function isKeyword(text: string): text is Keyword {
  return KEYWORD_SET.has(text)
}

/** Token description used in E010/E011 messages (docs/SPEC.md §11). */
export function describeToken(token: Token, source: string): string {
  switch (token.kind) {
    case 'EOF':
      return 'end of file'
    case 'Identifier':
      return `identifier '${String(token.value)}'`
    case 'Number':
      return `number ${source.slice(token.start, token.end)}`
    case 'String':
    case 'StringHead':
    case 'StringMiddle':
    case 'StringTail':
      return 'string'
    default:
      return isKeyword(token.kind) ? `keyword '${token.kind}'` : `'${token.kind}'`
  }
}
