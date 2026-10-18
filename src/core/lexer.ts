/**
 * The Hindsight lexer (docs/SPEC.md §2, docs/ARCHITECTURE.md §4.1). It reports every E001, E003
 * and E004, at most one of E006 > E002 > E005 at end of file, and never throws.
 */
import { compareDiagnostics, diagnostic } from './diagnostics'
import type { CompileErrorCode, Diagnostic } from './diagnostics'
import { span } from './span'
import type { Span } from './span'
import { PUNCTUATORS, isKeyword } from './tokens'
import type { Punctuator, Token, TokenKind } from './tokens'

export interface LexResult {
  readonly tokens: Token[]
  readonly comments: Span[]
  readonly diagnostics: Diagnostic[]
}

export function lex(source: string): LexResult {
  return new Lexer(source).run()
}

const BYTE_ORDER_MARK = 0xfeff
const MAX_CODE_POINT = 0x10ffff
const MAX_UNICODE_ESCAPE_DIGITS = 6

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['0', '\0'],
  ['\\', '\\'],
  ['"', '"'],
  ['{', '{'],
  ['}', '}'],
])

/** E001 hints (SPEC §11.1). */
const CHARACTER_HINTS: ReadonlyMap<string, string> = new Map([
  ['!', "use 'not' for negation or '!=' for inequality"],
  ['&', "use 'and'"],
  ["'", 'strings use double quotes'],
  ['`', 'strings use double quotes'],
  ['#', 'comments start with //'],
])

/** Punctuators grouped by first character, longest first (braces are handled separately). */
const PUNCTUATORS_BY_FIRST_CHAR: ReadonlyMap<string, readonly Punctuator[]> = (() => {
  const groups = new Map<string, Punctuator[]>()
  for (const punctuator of PUNCTUATORS) {
    if (punctuator === '{' || punctuator === '}') continue
    const first = punctuator.charAt(0)
    groups.set(first, [...(groups.get(first) ?? []), punctuator])
  }
  return groups
})()

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

function isIdentifierPart(ch: string): boolean {
  return isLetter(ch) || isDigit(ch) || ch === '_'
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')
}

/** The code point at `index` as text: one unit, or two for a surrogate pair. */
function codePointText(source: string, index: number): string {
  const codePoint = source.codePointAt(index) ?? 0
  return source.slice(index, index + (codePoint > 0xffff ? 2 : 1))
}

/** An interpolation whose closing `}` has not been seen yet. */
interface OpenInterpolation {
  /** Offset of the `{` that opened it. */
  readonly bracePos: number
  /** Offset of the opening `"` of the string it belongs to. */
  readonly quotePos: number
  /** Number of unmatched `{` inside the interpolation's code. */
  depth: number
}

interface CookedEscape {
  readonly text: string
  readonly end: number
}

class Lexer {
  private pos: number
  private readonly tokens: Token[] = []
  private readonly comments: Span[] = []
  private readonly diagnostics: Diagnostic[] = []
  private readonly interpolations: OpenInterpolation[] = []
  /** A line terminator was seen since the previous token. */
  private sawNewline = false
  /** Opening quote of a string that reached the end of the source, or -1. */
  private unterminatedQuote = -1
  /** Opening `/*` of a block comment that reached the end of the source, or -1. */
  private unterminatedComment = -1

  constructor(private readonly source: string) {
    this.pos = source.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0
  }

  run(): LexResult {
    while (this.pos < this.source.length) this.scanNext()
    this.reportUnterminated()
    this.emit('EOF', this.source.length, this.source.length)
    this.diagnostics.sort(compareDiagnostics)
    return { tokens: this.tokens, comments: this.comments, diagnostics: this.diagnostics }
  }

  private scanNext(): void {
    const ch = this.source.charAt(this.pos)
    const next = this.source.charAt(this.pos + 1)
    if (ch === ' ' || ch === '\t') this.pos++
    else if (ch === '\n' || ch === '\r') this.skipLineTerminator()
    else if (ch === '/' && next === '/') this.scanLineComment()
    else if (ch === '/' && next === '*') this.scanBlockComment()
    else if (ch === '"') this.scanStringPart(this.pos, this.pos, false)
    else if (isDigit(ch)) this.scanNumber()
    else if (isLetter(ch) || ch === '_') this.scanWord()
    else if (ch === '{') this.scanOpenBrace()
    else if (ch === '}') this.scanCloseBrace()
    else this.scanPunctuatorOrUnexpected(ch)
  }

  private emit(kind: TokenKind, start: number, end: number, value?: number | string): void {
    const newlineBefore = this.tokens.length > 0 && this.sawNewline
    this.sawNewline = false
    this.tokens.push(
      value === undefined
        ? { kind, start, end, newlineBefore }
        : { kind, start, end, newlineBefore, value },
    )
  }

  private report(
    code: CompileErrorCode,
    message: string,
    start: number,
    end: number,
    hint?: string,
  ): void {
    this.diagnostics.push(diagnostic(code, message, span(start, end), hint))
  }

  private skipLineTerminator(): void {
    this.sawNewline = true
    this.pos++
  }

  // -------------------------------------------------------------------------------------------
  // Comments

  private scanLineComment(): void {
    const start = this.pos
    let end = start + 2
    while (end < this.source.length) {
      const ch = this.source.charAt(end)
      if (ch === '\n' || ch === '\r') break
      end++
    }
    this.comments.push(span(start, end))
    this.pos = end
  }

  private scanBlockComment(): void {
    const start = this.pos
    let depth = 1
    let p = start + 2
    while (p < this.source.length && depth > 0) {
      const pair = this.source.slice(p, p + 2)
      if (pair === '/*') {
        depth++
        p += 2
      } else if (pair === '*/') {
        depth--
        p += 2
      } else {
        const ch = this.source.charAt(p)
        if (ch === '\n' || ch === '\r') this.sawNewline = true
        p++
      }
    }
    if (depth > 0) this.unterminatedComment = start
    this.comments.push(span(start, p))
    this.pos = p
  }

  // -------------------------------------------------------------------------------------------
  // Words and numbers

  private scanWord(): void {
    const start = this.pos
    let end = start + 1
    while (isIdentifierPart(this.source.charAt(end))) end++
    const text = this.source.slice(start, end)
    if (isKeyword(text)) this.emit(text, start, end)
    else this.emit('Identifier', start, end, text)
    this.pos = end
  }

  private skipDigits(from: number): number {
    let p = from
    while (isDigit(this.source.charAt(p)) || this.source.charAt(p) === '_') p++
    return p
  }

  private scanNumber(): void {
    const start = this.pos
    let end = this.skipDigits(start)
    if (this.source.charAt(end) === '.' && isDigit(this.source.charAt(end + 1))) {
      end = this.skipDigits(end + 1)
    }
    const marker = this.source.charAt(end)
    if (marker === 'e' || marker === 'E') {
      let digits = end + 1
      const sign = this.source.charAt(digits)
      if (sign === '+' || sign === '-') digits++
      if (isDigit(this.source.charAt(digits))) end = this.skipDigits(digits)
    }
    if (isLetter(this.source.charAt(end))) {
      while (isIdentifierPart(this.source.charAt(end))) end++
      const lexeme = this.source.slice(start, end)
      this.report('E004', `invalid number literal '${lexeme}'`, start, end)
      this.emit('Number', start, end, NaN)
    } else {
      this.emit('Number', start, end, Number(this.source.slice(start, end).replaceAll('_', '')))
    }
    this.pos = end
  }

  // -------------------------------------------------------------------------------------------
  // Strings and interpolation

  /**
   * Scans string text that starts just after `start` (an opening `"`, or the `}` that closes an
   * interpolation when `continuation` is true) up to the closing `"`, the `{` of the next
   * interpolation, or the end of the source.
   */
  private scanStringPart(start: number, quotePos: number, continuation: boolean): void {
    let cooked = ''
    let chunkStart = start + 1
    let p = start + 1
    while (p < this.source.length) {
      const ch = this.source.charAt(p)
      if (ch === '"' || ch === '{') {
        cooked += this.source.slice(chunkStart, p)
        if (ch === '{') this.interpolations.push({ bracePos: p, quotePos, depth: 0 })
        const kind = ch === '"' ? (continuation ? 'StringTail' : 'String') : continuation ? 'StringMiddle' : 'StringHead'
        this.emit(kind, start, p + 1, cooked)
        this.pos = p + 1
        return
      }
      if (ch === '\\') {
        cooked += this.source.slice(chunkStart, p)
        const escape = this.scanEscape(p)
        cooked += escape.text
        p = escape.end
        chunkStart = p
      } else {
        p++
      }
    }
    cooked += this.source.slice(chunkStart, p)
    this.unterminatedQuote = quotePos
    this.emit(continuation ? 'StringTail' : 'String', start, p, cooked)
    this.pos = p
  }

  private scanEscape(backslash: number): CookedEscape {
    const next = this.source.charAt(backslash + 1)
    // A backslash at the very end leaves the string open; E002 covers it.
    if (next === '') return { text: '', end: backslash + 1 }
    const simple = SIMPLE_ESCAPES.get(next)
    if (simple !== undefined) return { text: simple, end: backslash + 2 }
    if (next === 'u') return this.scanUnicodeEscape(backslash)
    const escaped = codePointText(this.source, backslash + 1)
    const end = backslash + 1 + escaped.length
    this.report('E003', `unknown escape sequence '\\${escaped}'`, backslash, end)
    return { text: escaped, end }
  }

  private scanUnicodeEscape(backslash: number): CookedEscape {
    let p = backslash + 2
    if (this.source.charAt(p) !== '{') return this.invalidUnicodeEscape(backslash, p)
    p++
    const digitsStart = p
    while (isHexDigit(this.source.charAt(p))) p++
    const digitCount = p - digitsStart
    if (this.source.charAt(p) !== '}') return this.invalidUnicodeEscape(backslash, p)
    p++
    const valid = digitCount >= 1 && digitCount <= MAX_UNICODE_ESCAPE_DIGITS
    const codePoint = valid ? parseInt(this.source.slice(digitsStart, digitsStart + digitCount), 16) : NaN
    if (!(codePoint <= MAX_CODE_POINT)) return this.invalidUnicodeEscape(backslash, p)
    return { text: String.fromCodePoint(codePoint), end: p }
  }

  private invalidUnicodeEscape(backslash: number, end: number): CookedEscape {
    this.report('E003', 'invalid unicode escape', backslash, end)
    return { text: this.source.slice(backslash + 1, end), end }
  }

  private scanOpenBrace(): void {
    const innermost = this.interpolations.at(-1)
    if (innermost !== undefined) innermost.depth++
    this.emit('{', this.pos, this.pos + 1)
    this.pos++
  }

  private scanCloseBrace(): void {
    const innermost = this.interpolations.at(-1)
    if (innermost === undefined || innermost.depth > 0) {
      if (innermost !== undefined) innermost.depth--
      this.emit('}', this.pos, this.pos + 1)
      this.pos++
      return
    }
    this.interpolations.pop()
    this.scanStringPart(this.pos, innermost.quotePos, true)
  }

  // -------------------------------------------------------------------------------------------
  // Punctuators and errors

  private scanPunctuatorOrUnexpected(ch: string): void {
    const candidates = PUNCTUATORS_BY_FIRST_CHAR.get(ch) ?? []
    const punctuator = candidates.find((p) => this.source.startsWith(p, this.pos))
    if (punctuator !== undefined) {
      this.emit(punctuator, this.pos, this.pos + punctuator.length)
      this.pos += punctuator.length
      return
    }
    const character = codePointText(this.source, this.pos)
    const end = this.pos + character.length
    this.report('E001', `unexpected character '${character}'`, this.pos, end, CHARACTER_HINTS.get(character))
    this.pos = end
  }

  /** At most one of E006 > E002 > E005 (SPEC §2.8). */
  private reportUnterminated(): void {
    const outermost = this.interpolations[0]
    if (outermost !== undefined) {
      const brace = outermost.bracePos
      this.report('E006', 'unterminated string interpolation', brace, brace + 1)
    } else if (this.unterminatedQuote >= 0) {
      const quote = this.unterminatedQuote
      this.report('E002', 'unterminated string', quote, quote + 1)
    } else if (this.unterminatedComment >= 0) {
      const opener = this.unterminatedComment
      this.report('E005', 'unterminated block comment', opener, opener + 2)
    }
  }
}
