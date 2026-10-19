/**
 * Shared parser state (docs/ARCHITECTURE.md §4.2): the token cursor, the newline-sensitivity
 * context stack, the E028 nesting limits, the first-syntax-error abort and the post-parse checks.
 */
import { diagnostic } from './diagnostics'
import type { CompileErrorCode, Diagnostic } from './diagnostics'
import { span } from './span'
import type { Span } from './span'
import { describeToken } from './tokens'
import type { Token, TokenKind } from './tokens'

/** More constructs than this open at once is E028 (SPEC §3.5). */
export const MAX_OPEN_CONSTRUCTS = 256
/** A syntax tree deeper than this is E028 (SPEC §3.5). */
export const MAX_TREE_DEPTH = 512

const NESTED_TOO_DEEPLY = 'expression is nested too deeply'

/** Thrown internally at the first syntax error; `parse` catches it and never lets it escape. */
export class SyntaxAbort extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message)
    this.name = 'SyntaxAbort'
  }
}

/** The empty span just after the last non-whitespace character (comments included). */
function endOfFileAnchor(source: string): Span {
  let end = source.length
  while (end > 0 && ' \t\r\n'.includes(source.charAt(end - 1))) end--
  return span(end, end)
}

export abstract class ParserBase {
  protected pos = 0
  /** Diagnostics of the post-parse checks (SPEC §3.6), reported only without a syntax error. */
  protected checks: Diagnostic[] = []
  /** Newline sensitivity of the enclosing constructs; true = sensitive (SPEC §3.2). */
  private readonly contexts: boolean[] = []
  private openConstructs = 0
  /** Nodes under construction that will be ancestors of whatever is parsed now. */
  private pathDepth = 0
  /** Height of every node built so far, for the tree-depth limit. */
  private readonly heights = new WeakMap<object, number>()
  private readonly eofAnchor: Span

  constructor(
    protected readonly source: string,
    private readonly tokens: readonly Token[],
  ) {
    this.eofAnchor = endOfFileAnchor(source)
  }

  /** The post-parse check diagnostics recorded so far (unsorted). */
  recordedChecks(): readonly Diagnostic[] {
    return this.checks
  }

  // -------------------------------------------------------------------------------------------
  // Token cursor

  protected peek(): Token {
    return this.tokens[this.pos]!
  }

  protected peekAt(offset: number): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!
  }

  protected at(kind: TokenKind): boolean {
    return this.tokens[this.pos]!.kind === kind
  }

  /** Consumes the current token (the final EOF token is never consumed). */
  protected next(): Token {
    const token = this.peek()
    if (token.kind !== 'EOF') this.pos++
    return token
  }

  /** End offset of the last consumed token. */
  protected get prevEnd(): number {
    return this.pos === 0 ? 0 : this.tokens[this.pos - 1]!.end
  }

  protected spanFrom(start: number): Span {
    return span(start, this.prevEnd)
  }

  /** The span a diagnostic about `token` is anchored at (SPEC §11.1). */
  protected tokenSpan(token: Token): Span {
    return token.kind === 'EOF' ? this.eofAnchor : span(token.start, token.end)
  }

  // -------------------------------------------------------------------------------------------
  // Syntax errors (stop parsing) and checks (recorded, parsing continues)

  protected fail(code: CompileErrorCode, message: string, token: Token): never {
    throw new SyntaxAbort(diagnostic(code, message, this.tokenSpan(token)))
  }

  /** E010 `expected EXPECTED but found FOUND`. */
  protected failExpected(expected: string, token: Token = this.peek()): never {
    return this.fail('E010', `expected ${expected} but found ${this.describe(token)}`, token)
  }

  /** E011 `expected an expression but found FOUND`. */
  protected failExpression(token: Token = this.peek()): never {
    return this.fail('E011', `expected an expression but found ${this.describe(token)}`, token)
  }

  /** E015 `invalid pattern`. */
  protected failPattern(token: Token = this.peek()): never {
    return this.fail('E015', 'invalid pattern', token)
  }

  /** Consumes a token of `kind`, or fails with E010 naming it as the expected token. */
  protected expect(kind: TokenKind): Token {
    if (!this.at(kind)) this.failExpected(`'${kind}'`)
    return this.next()
  }

  protected check(code: CompileErrorCode, message: string, at: Span, hint?: string): void {
    this.checks.push(diagnostic(code, message, at, hint))
  }

  protected describe(token: Token): string {
    return describeToken(token, this.source)
  }

  // -------------------------------------------------------------------------------------------
  // Newline sensitivity (SPEC §3.2)

  protected pushContext(sensitive: boolean): void {
    this.contexts.push(sensitive)
  }

  protected popContext(): void {
    this.contexts.pop()
  }

  /** True when `token` may not continue an expression because it starts a new line (rule 1). */
  protected blockedByNewline(token: Token): boolean {
    return token.newlineBefore && this.contexts.at(-1) === true
  }

  // -------------------------------------------------------------------------------------------
  // Nesting limits (E028)

  /** Opens a bracket, brace, block, interpolation or prefix operator at `token`. */
  protected openConstruct(token: Token): void {
    this.openConstructs++
    if (this.openConstructs > MAX_OPEN_CONSTRUCTS) this.fail('E028', NESTED_TOO_DEEPLY, token)
  }

  protected closeConstruct(): void {
    this.openConstructs--
  }

  /**
   * Starts parsing the children of a node that will be built afterwards. Bounding this depth also
   * bounds the parser's own recursion, so it never approaches the JavaScript stack limit.
   */
  protected enter(): void {
    this.pathDepth++
    // The child about to be parsed has height >= 1, so the tree would exceed the limit.
    if (this.pathDepth >= MAX_TREE_DEPTH) this.fail('E028', NESTED_TOO_DEEPLY, this.peek())
  }

  protected leave(): void {
    this.pathDepth--
  }

  /** Registers a freshly built node and enforces the tree-depth limit. */
  protected node<T extends object>(value: T, anchor?: Token): T {
    const height = this.childHeight(value) + 1
    this.heights.set(value, height)
    if (this.pathDepth + height > MAX_TREE_DEPTH) {
      this.fail('E028', NESTED_TOO_DEEPLY, anchor ?? this.tokens[Math.max(0, this.pos - 1)]!)
    }
    return value
  }

  private childHeight(value: object): number {
    let height = 0
    for (const field of Object.values(value)) {
      if (Array.isArray(field)) {
        for (const item of field) height = Math.max(height, this.heightOf(item))
      } else {
        height = Math.max(height, this.heightOf(field))
      }
    }
    return height
  }

  private heightOf(value: unknown): number {
    return typeof value === 'object' && value !== null ? (this.heights.get(value) ?? 0) : 0
  }
}
