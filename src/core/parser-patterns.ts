/**
 * Pattern parsing (SPEC §3.1 `pattern`, §3.5 E015 rules, §6).
 */
import type { ListPattern, Pattern, RecordPattern, RecordPatternField, RestPattern } from './ast'
import { ParserBase } from './parser-context'
import {
  alternativeDiagnostics,
  duplicateBindingDiagnostics,
  patternBinders,
} from './parser-checks'
import type { Binder, PatternRole } from './parser-checks'
import { span } from './span'
import type { Span } from './span'
import type { Token, TokenKind } from './tokens'

/** Tokens that may not directly follow a complete altPattern (E015, SPEC §3.5). */
const INVALID_AFTER_PATTERN: ReadonlySet<TokenKind> = new Set<TokenKind>([
  '(',
  '[',
  '.',
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'and',
  'or',
  '|>',
  // A number literal followed by `..` is a range pattern; anything else followed by it is invalid.
  '..',
  '..=',
])

export abstract class PatternParser extends ParserBase {
  /** First `|` of the top-level pattern being parsed, for the E015 alternatives check. */
  private firstBar: Span | null = null

  /**
   * Parses one pattern in `role` and records its alternative and E023 checks. With
   * `topLevelBars = false` (lambda parameters) a top-level `|` ends the pattern. Returns the pattern
   * and its binders (for checks across parameter lists).
   */
  protected parseCheckedPattern(
    role: PatternRole,
    topLevelBars = true,
  ): { pattern: Pattern; binders: Binder[] } {
    this.firstBar = null
    const pattern = topLevelBars ? this.parsePattern() : this.parseAltPattern()
    const binders = patternBinders(pattern)
    this.checks.push(...alternativeDiagnostics(role, binders, this.firstBar))
    return { pattern, binders }
  }

  /** Records E023 for names repeated across `binders` (one pattern or a parameter list). */
  protected checkDuplicateBindings(binders: readonly Binder[]): void {
    this.checks.push(...duplicateBindingDiagnostics(binders))
  }

  /** `pattern = altPattern { "|" altPattern }`. */
  private parsePattern(): Pattern {
    const start = this.peek().start
    const first = this.parseAltPattern()
    if (!this.at('|')) return first
    const alternatives = [first]
    while (this.at('|')) {
      const bar = this.next()
      if (this.firstBar === null) this.firstBar = this.tokenSpan(bar)
      alternatives.push(this.parseAltPattern())
    }
    return this.node({ kind: 'POr', alternatives, span: this.spanFrom(start) })
  }

  private parseAltPattern(): Pattern {
    const pattern = this.parseAltPatternStart()
    this.checkPatternFollower()
    return pattern
  }

  private parseAltPatternStart(): Pattern {
    const token = this.peek()
    switch (token.kind) {
      case 'Identifier':
        this.next()
        return this.nameNode(token)
      case 'Number':
      case '-':
        return this.parseNumberPattern()
      case 'String':
        this.next()
        return this.literal(String(token.value), token)
      case 'true':
      case 'false':
        this.next()
        return this.literal(token.kind === 'true', token)
      case 'nil':
        this.next()
        return this.literal(null, token)
      case '[':
        return this.parseListPattern()
      case '{':
        return this.parseRecordPattern()
      default:
        return this.failPattern(token)
    }
  }

  /** E015 when a complete altPattern is followed by a call, index, member or operator token. */
  private checkPatternFollower(): void {
    if (INVALID_AFTER_PATTERN.has(this.peek().kind)) this.failPattern()
  }

  private nameNode(token: Token): Pattern {
    const at = span(token.start, token.end)
    return token.value === '_'
      ? this.node({ kind: 'PWildcard', span: at })
      : this.node({ kind: 'PBind', name: String(token.value), span: at })
  }

  private literal(value: number | string | boolean | null, token: Token): Pattern {
    return this.node({ kind: 'PLiteral', value, span: span(token.start, token.end) })
  }

  /** `[-] NUMBER`, optionally followed by `..`/`..=` and a second `[-] NUMBER` bound. */
  private parseNumberPattern(): Pattern {
    const start = this.peek().start
    const value = this.parseSignedNumber()
    if (!this.at('..') && !this.at('..=')) {
      return this.node({ kind: 'PLiteral', value, span: this.spanFrom(start) })
    }
    const inclusive = this.next().kind === '..='
    const end = this.parseSignedNumber()
    return this.node({ kind: 'PRange', start: value, end, inclusive, span: this.spanFrom(start) })
  }

  /** A `[-] NUMBER`; anything else is E015 at its first token. */
  private parseSignedNumber(): number {
    const first = this.peek()
    const negative = first.kind === '-'
    if (negative) this.next()
    const number = this.peek()
    if (number.kind !== 'Number') return this.failPattern(first)
    this.next()
    const value = Number(number.value)
    return negative ? -value : value
  }

  private parseListPattern(): ListPattern {
    const open = this.next()
    this.openConstruct(open)
    this.enter()
    const before: Pattern[] = []
    const after: Pattern[] = []
    let rest: RestPattern | null = null
    while (!this.at(']')) {
      if (this.at('...')) {
        const dots = this.peek()
        const element = this.parseRestPattern()
        if (rest === null) rest = element
        else
          this.check(
            'E016',
            "a list pattern can contain at most one '...rest'",
            this.tokenSpan(dots),
          )
      } else {
        ;(rest === null ? before : after).push(this.parsePattern())
      }
      if (this.at(',')) this.next()
      else if (!this.at(']')) this.failExpected("']'")
    }
    this.next()
    this.leave()
    this.closeConstruct()
    return this.node({ kind: 'PList', before, rest, after, span: this.spanFrom(open.start) })
  }

  /** `...`, `..._` (both discard) or `...name`. Its span ends at the name, if any. */
  private parseRestPattern(): RestPattern {
    const dots = this.next()
    const nameToken = this.at('Identifier') ? this.next() : null
    const name = nameToken === null || nameToken.value === '_' ? null : String(nameToken.value)
    return this.node({ kind: 'PRest', name, span: this.spanFrom(dots.start) })
  }

  private parseRecordPattern(): RecordPattern {
    const open = this.next()
    this.openConstruct(open)
    this.enter()
    const fields: RecordPatternField[] = []
    while (!this.at('}')) {
      fields.push(this.parseRecordPatternField())
      if (this.at(',')) this.next()
      else if (!this.at('}')) this.failExpected("'}'")
    }
    this.next()
    this.leave()
    this.closeConstruct()
    return this.node({ kind: 'PRecord', fields, span: this.spanFrom(open.start) })
  }

  /** `IDENT [":" pattern]` or `STRING ":" pattern`. */
  private parseRecordPatternField(): RecordPatternField {
    const key = this.peek()
    if (key.kind !== 'Identifier' && key.kind !== 'String') return this.failPattern(key)
    this.next()
    const keySpan = span(key.start, key.end)
    const shorthand = key.kind === 'Identifier' && !this.at(':')
    let pattern: Pattern
    if (shorthand) {
      pattern = this.nameNode(key)
      this.checkPatternFollower()
    } else {
      this.expect(':')
      this.enter()
      pattern = this.parsePattern()
      this.leave()
    }
    const field = {
      key: String(key.value),
      keySpan,
      pattern,
      shorthand,
      span: this.spanFrom(key.start),
    }
    return this.node(field)
  }
}
