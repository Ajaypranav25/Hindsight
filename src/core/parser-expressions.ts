/**
 * Expression parsing (SPEC §3.1 `expr` … `primary`, §3.2 newline rules, §3.3 precedence, §3.4
 * invisible parentheses, §7.11 pipe desugaring).
 */
import type {
  BinaryOp,
  Block,
  Call,
  Expr,
  FunctionExpr,
  IfExpr,
  ListLit,
  MatchArm,
  MatchExpr,
  Pattern,
  RecordField,
  RecordLit,
  Spread,
  TemplateLit,
} from './ast'
import type { Binder } from './parser-checks'
import { PatternParser } from './parser-patterns'
import { span } from './span'
import type { Token, TokenKind } from './tokens'

const PIPE_LEVEL = 1
const OR_LEVEL = 2
const NOT_LEVEL = 4
const COMPARISON_LEVEL = 5
const RANGE_LEVEL = 6

/** Binary operator precedence levels (SPEC §3.3); `not` (4), prefix `-` and `**` are separate. */
const BINARY_LEVELS: ReadonlyMap<TokenKind, number> = new Map<TokenKind, number>([
  ['|>', PIPE_LEVEL],
  ['or', OR_LEVEL],
  ['and', 3],
  ['==', COMPARISON_LEVEL],
  ['!=', COMPARISON_LEVEL],
  ['<', COMPARISON_LEVEL],
  ['<=', COMPARISON_LEVEL],
  ['>', COMPARISON_LEVEL],
  ['>=', COMPARISON_LEVEL],
  ['..', RANGE_LEVEL],
  ['..=', RANGE_LEVEL],
  ['+', 7],
  ['-', 7],
  ['*', 8],
  ['/', 8],
  ['%', 8],
])

export abstract class ExpressionParser extends PatternParser {
  /** `block = "{" { stmt } "}"`, implemented by the statement parser. */
  protected abstract parseBlock(): Block

  protected parseExpr(): Expr {
    return this.parseLevel(PIPE_LEVEL)
  }

  /** `block | expr`: a `{` always starts a block here (lambda and arm bodies). */
  protected parseBody(): Block | Expr {
    return this.at('{') ? this.parseBlock() : this.parseExpr()
  }

  // -------------------------------------------------------------------------------------------
  // Binary operators by precedence climbing

  /** Parses operators of level `min` and above; `not` may only start levels up to NOT_LEVEL. */
  private parseLevel(min: number): Expr {
    const start = this.peek().start
    let left = this.at('not') && min <= NOT_LEVEL ? this.parseNot() : this.parseUnary()
    let usedComparison = false
    let usedRange = false
    for (;;) {
      const op = this.peek()
      const level = BINARY_LEVELS.get(op.kind)
      if (level === undefined || level < min) break
      if (op.kind !== '|>' && this.blockedByNewline(op)) break
      this.next()
      if (level === COMPARISON_LEVEL) {
        if (usedComparison) {
          this.check(
            'E013',
            'comparison operators cannot be chained',
            this.tokenSpan(op),
            "write 'a < b and b < c'",
          )
        }
        usedComparison = true
      } else if (level === RANGE_LEVEL) {
        if (usedRange) this.check('E014', 'range operators cannot be chained', this.tokenSpan(op))
        usedRange = true
      }
      this.enter()
      const right = this.parseLevel(op.kind === '|>' ? OR_LEVEL : level + 1)
      this.leave()
      left = this.combine(op, left, right, start)
    }
    return left
  }

  private combine(op: Token, left: Expr, right: Expr, start: number): Expr {
    const whole = this.spanFrom(start)
    switch (op.kind) {
      case '|>':
        return this.pipeCall(op, left, right, start)
      case 'and':
      case 'or':
        return this.node({ kind: 'Logical', op: op.kind, left, right, span: whole }, op)
      default: {
        const opSpan = span(op.start, op.end)
        // Every remaining operator of BINARY_LEVELS is a BinaryOp.
        const binaryOp = op.kind as BinaryOp
        return this.node({ kind: 'Binary', op: binaryOp, left, right, opSpan, span: whole }, op)
      }
    }
  }

  /** `x |> f(a)` is `f(x, a)`; `x |> g` is `g(x)` (SPEC §7.11). */
  private pipeCall(op: Token, left: Expr, right: Expr, start: number): Call {
    const pipeSpan = span(op.start, this.prevEnd)
    const whole = this.spanFrom(start)
    const call: Call =
      right.kind === 'Call'
        ? {
            kind: 'Call',
            callee: right.callee,
            args: [left, ...right.args],
            pipe: true,
            pipeSpan,
            span: whole,
          }
        : { kind: 'Call', callee: right, args: [left], pipe: true, pipeSpan, span: whole }
    return this.node(call, op)
  }

  private parseNot(): Expr {
    const not = this.next()
    this.openConstruct(not)
    this.enter()
    const operand = this.at('not') ? this.parseNot() : this.parseLevel(COMPARISON_LEVEL)
    this.leave()
    this.closeConstruct()
    return this.node({ kind: 'Unary', op: 'not', operand, span: this.spanFrom(not.start) })
  }

  /** `unary = "-" unary | power`. */
  private parseUnary(): Expr {
    if (!this.at('-')) return this.parsePower()
    const minus = this.next()
    this.openConstruct(minus)
    this.enter()
    const operand = this.parseUnary()
    this.leave()
    this.closeConstruct()
    return this.node({ kind: 'Unary', op: '-', operand, span: this.spanFrom(minus.start) })
  }

  /** `power = postfix [ "**" unary ]` (right-associative through `unary`). */
  private parsePower(): Expr {
    const start = this.peek().start
    const base = this.parsePostfix()
    const op = this.peek()
    if (op.kind !== '**' || this.blockedByNewline(op)) return base
    this.next()
    this.enter()
    const exponent = this.parseUnary()
    this.leave()
    const opSpan = span(op.start, op.end)
    return this.node(
      { kind: 'Binary', op: '**', left: base, right: exponent, opSpan, span: this.spanFrom(start) },
      op,
    )
  }

  // -------------------------------------------------------------------------------------------
  // Postfix: calls, indexing, member access

  private parsePostfix(): Expr {
    const start = this.peek().start
    let expr = this.parsePrimary()
    for (;;) {
      const token = this.peek()
      if (token.kind === '(' && !this.blockedByNewline(token)) expr = this.parseCall(expr, start)
      else if (token.kind === '[' && !this.blockedByNewline(token))
        expr = this.parseIndex(expr, start)
      else if (token.kind === '.') expr = this.parseMember(expr, start)
      else return expr
    }
  }

  private parseCall(callee: Expr, start: number): Expr {
    const args = this.parseBracketed(() => this.parseExprList(')'))
    return this.node({
      kind: 'Call',
      callee,
      args,
      pipe: false,
      pipeSpan: null,
      span: this.spanFrom(start),
    })
  }

  private parseIndex(object: Expr, start: number): Expr {
    const index = this.parseBracketed(() => {
      const inner = this.parseExpr()
      this.expect(']')
      return inner
    })
    return this.node({ kind: 'Index', object, index, span: this.spanFrom(start) })
  }

  private parseMember(object: Expr, start: number): Expr {
    const dot = this.next()
    const name = this.peek()
    if (name.kind !== 'Identifier') return this.failExpected('an identifier')
    this.next()
    return this.node({
      kind: 'Member',
      object,
      name: String(name.value),
      nameSpan: span(name.start, name.end),
      accessSpan: span(dot.start, name.end),
      span: this.spanFrom(start),
    })
  }

  /**
   * Consumes an opening bracket and runs `parseContents` (which consumes the closing one) in a
   * newline-insensitive context, counting the bracket as an open construct.
   */
  private parseBracketed<T>(parseContents: () => T): T {
    this.openConstruct(this.next())
    this.pushContext(false)
    this.enter()
    const contents = parseContents()
    this.leave()
    this.popContext()
    this.closeConstruct()
    return contents
  }

  /** `[ expr { "," expr } [ "," ] ] close`, consuming `close`. */
  private parseExprList(close: ')' | ']'): Expr[] {
    const items: Expr[] = []
    while (!this.at(close)) {
      items.push(this.parseExpr())
      this.endListItem(close)
    }
    this.next()
    return items
  }

  /** After an item of a bracketed comma list: a `,`, or else the closing token must follow. */
  private endListItem(close: TokenKind): void {
    if (this.at(',')) this.next()
    else if (!this.at(close)) this.failExpected(`'${close}'`)
  }

  // -------------------------------------------------------------------------------------------
  // Primary expressions

  private parsePrimary(): Expr {
    const token = this.peek()
    switch (token.kind) {
      case 'Number':
        this.next()
        return this.node({
          kind: 'Number',
          value: Number(token.value),
          span: this.tokenSpan(token),
        })
      case 'String':
        this.next()
        return this.node({
          kind: 'String',
          value: String(token.value),
          span: this.tokenSpan(token),
        })
      case 'StringHead':
        return this.parseTemplate()
      case 'true':
      case 'false':
        this.next()
        return this.node({
          kind: 'Bool',
          value: token.kind === 'true',
          span: this.tokenSpan(token),
        })
      case 'nil':
        this.next()
        return this.node({ kind: 'Nil', span: this.tokenSpan(token) })
      case 'Identifier':
        this.next()
        return this.identifier(token)
      case '(':
        return this.parseGroup()
      case '[':
        return this.parseList()
      case '{':
        return this.parseRecord()
      case '|':
        return this.parseLambda()
      case 'fn':
        return this.parseFnExpr()
      case 'if':
        return this.parseIf()
      case 'match':
        return this.parseMatch()
      default:
        return this.failExpression(token)
    }
  }

  /** An identifier used as a value; `_` there is E027. */
  private identifier(token: Token): Expr {
    const name = String(token.value)
    const at = span(token.start, token.end)
    if (name === '_') this.check('E027', "'_' can only be used in patterns", at)
    return this.node({ kind: 'Ident', name, span: at })
  }

  /** `( expr )`: parentheses only group and leave no trace in the tree (SPEC §3.4). */
  private parseGroup(): Expr {
    const open = this.next()
    this.openConstruct(open)
    this.pushContext(false)
    const inner = this.parseExpr()
    this.expect(')')
    this.popContext()
    this.closeConstruct()
    return inner
  }

  private parseTemplate(): TemplateLit {
    const head = this.next()
    this.openConstruct(head)
    this.pushContext(false)
    this.enter()
    const quasis = [String(head.value)]
    const exprs: Expr[] = []
    for (;;) {
      exprs.push(this.parseExpr())
      const part = this.peek()
      if (part.kind !== 'StringMiddle' && part.kind !== 'StringTail') this.failExpected("'}'")
      this.next()
      quasis.push(String(part.value))
      if (part.kind === 'StringTail') break
    }
    this.leave()
    this.popContext()
    this.closeConstruct()
    return this.node({ kind: 'Template', quasis, exprs, span: this.spanFrom(head.start) })
  }

  private parseList(): ListLit {
    const start = this.peek().start
    const items = this.parseBracketed(() => {
      const parsed: (Expr | Spread)[] = []
      while (!this.at(']')) {
        parsed.push(this.at('...') ? this.parseSpread() : this.parseExpr())
        this.endListItem(']')
      }
      this.next()
      return parsed
    })
    return this.node({ kind: 'List', items, span: this.spanFrom(start) })
  }

  private parseSpread(): Spread {
    const dots = this.next()
    const expr = this.parseExpr()
    return this.node({ kind: 'Spread', expr, span: this.spanFrom(dots.start) })
  }

  private parseRecord(): RecordLit {
    const start = this.peek().start
    const items = this.parseBracketed(() => {
      const parsed: (RecordField | Spread)[] = []
      const keys = new Set<string>()
      while (!this.at('}')) {
        parsed.push(this.at('...') ? this.parseSpread() : this.parseField(keys))
        this.endListItem('}')
      }
      this.next()
      return parsed
    })
    return this.node({ kind: 'Record', items, span: this.spanFrom(start) })
  }

  /** `( IDENT | STRING ) ":" expr | IDENT`; repeated keys are E019. */
  private parseField(keys: Set<string>): RecordField {
    const key = this.peek()
    if (key.kind !== 'Identifier' && key.kind !== 'String')
      return this.failExpected('an identifier')
    this.next()
    const name = String(key.value)
    const keySpan = span(key.start, key.end)
    if (keys.has(name)) this.check('E019', `duplicate field '${name}' in record literal`, keySpan)
    keys.add(name)
    const shorthand = key.kind === 'Identifier' && !this.at(':')
    if (!shorthand) this.expect(':')
    const value = shorthand ? this.identifier(key) : this.parseExpr()
    return this.node({
      kind: 'Field',
      key: name,
      keySpan,
      value,
      shorthand,
      span: this.spanFrom(key.start),
    })
  }

  // -------------------------------------------------------------------------------------------
  // Functions

  /** `"|" [ params ] "|" body`; `||` and `| |` are empty parameter lists. */
  private parseLambda(): FunctionExpr {
    const bar = this.next()
    this.enter()
    const params = this.parseParams('|')
    const body = this.parseBody()
    this.leave()
    return this.node({
      kind: 'Function',
      name: null,
      params,
      body,
      form: 'lambda',
      span: this.spanFrom(bar.start),
    })
  }

  private parseFnExpr(): FunctionExpr {
    const start = this.next().start
    if (!this.at('(')) return this.failExpected("'('")
    return this.parseFunctionTail(start, null)
  }

  /** `"(" [ params ] ")" block` of `fn NAME(…)` or `fn(…)`; the current token is `(`. */
  protected parseFunctionTail(start: number, name: string | null): FunctionExpr {
    this.enter()
    this.openConstruct(this.next())
    const params = this.parseParams(')')
    this.closeConstruct()
    const body = this.parseBlock()
    this.leave()
    return this.node({
      kind: 'Function',
      name,
      params,
      body,
      form: 'fn',
      span: this.spanFrom(start),
    })
  }

  /**
   * `[ pattern { "," pattern } [ "," ] ] close`, consuming `close`. Inside lambda bars a top-level
   * `|` ends a parameter. A name may be bound once across the whole list (E023).
   */
  private parseParams(close: ')' | '|'): Pattern[] {
    const params: Pattern[] = []
    const binders: Binder[] = []
    while (!this.at(close)) {
      const parsed = this.parseCheckedPattern('binding', close !== '|')
      params.push(parsed.pattern)
      binders.push(...parsed.binders)
      this.endListItem(close)
    }
    this.next()
    this.checkDuplicateBindings(binders)
    return params
  }

  // -------------------------------------------------------------------------------------------
  // if and match

  /** `"if" expr block [ "else" ( ifExpr | block ) ]`; `else` may start the next line. */
  private parseIf(): IfExpr {
    const start = this.next().start
    this.enter()
    const cond = this.parseExpr()
    const then = this.parseBlock()
    let otherwise: Block | IfExpr | null = null
    if (this.at('else')) {
      this.next()
      otherwise = this.at('if') ? this.parseIf() : this.parseBlock()
    }
    this.leave()
    return this.node({ kind: 'If', cond, then, else: otherwise, span: this.spanFrom(start) })
  }

  /** `"match" expr "{" { arm [ "," ] } "}"`; the braces are newline-sensitive. */
  private parseMatch(): MatchExpr {
    const start = this.next().start
    this.enter()
    const subject = this.parseExpr()
    const open = this.expect('{')
    this.openConstruct(open)
    this.pushContext(true)
    const arms: MatchArm[] = []
    while (!this.at('}')) {
      if (this.at('EOF')) this.failExpected("'}'")
      arms.push(this.parseArm())
      this.endArm()
    }
    this.next()
    this.popContext()
    this.closeConstruct()
    this.leave()
    return this.node({ kind: 'Match', subject, arms, span: this.spanFrom(start) })
  }

  /** Arms are separated by `,` or a newline (E018 otherwise). */
  private endArm(): void {
    const token = this.peek()
    if (token.kind === ',') this.next()
    else if (!token.newlineBefore && token.kind !== '}' && token.kind !== 'EOF') {
      this.fail('E018', "expected a newline or ',' between match arms", token)
    }
  }

  /** `pattern [ "if" expr ] "=>" body`. */
  private parseArm(): MatchArm {
    const start = this.peek().start
    this.enter()
    const { pattern, binders } = this.parseCheckedPattern('match')
    this.checkDuplicateBindings(binders)
    let guard: Expr | null = null
    if (this.at('if')) {
      this.next()
      guard = this.parseExpr()
    }
    this.expect('=>')
    const body = this.parseBody()
    this.leave()
    return this.node({ kind: 'Arm', pattern, guard, body, span: this.spanFrom(start) })
  }
}
