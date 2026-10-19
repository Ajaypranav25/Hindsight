/**
 * Statement parsing (SPEC §3.1 `program` … `exprOrAssign`, statement separation, E012).
 */
import type { AssignOp, Block, Expr, Program, Stmt } from './ast'
import { ExpressionParser } from './parser-expressions'
import { span } from './span'
import type { TokenKind } from './tokens'

const ASSIGN_OPS: ReadonlySet<TokenKind> = new Set<TokenKind>(['=', '+=', '-=', '*=', '/=', '%='])

export class StatementParser extends ExpressionParser {
  parseProgram(): Program {
    this.pushContext(true)
    const body = this.parseStatements(false)
    this.popContext()
    return this.node({ kind: 'Program', body, span: span(0, this.source.length) })
  }

  /** `"{" { stmt } "}"`; the block is newline-sensitive. A missing `{` is E010 `'{'`. */
  protected parseBlock(): Block {
    const open = this.expect('{')
    this.openConstruct(open)
    this.pushContext(true)
    this.enter()
    const body = this.parseStatements(true)
    this.next()
    this.leave()
    this.popContext()
    this.closeConstruct()
    return this.node({ kind: 'Block', body, span: this.spanFrom(open.start) })
  }

  /** Statements up to the closing `}` (not consumed) or the end of the program. */
  private parseStatements(inBlock: boolean): Stmt[] {
    const body: Stmt[] = []
    for (;;) {
      if (this.at('EOF')) {
        if (inBlock) this.failExpected("'}'")
        return body
      }
      if (inBlock && this.at('}')) return body
      body.push(this.parseStatement())
      this.endStatement()
    }
  }

  /** After a statement: `;`, a new line, `}` or end of file (E018 otherwise). */
  private endStatement(): void {
    const token = this.peek()
    if (token.kind === ';') this.next()
    else if (!token.newlineBefore && token.kind !== '}' && token.kind !== 'EOF') {
      this.fail('E018', "expected a newline or ';' between statements", token)
    }
  }

  private parseStatement(): Stmt {
    const token = this.peek()
    switch (token.kind) {
      case 'let':
      case 'var':
        return this.parseLet()
      case 'fn':
        return this.peekAt(1).kind === '(' ? this.parseExpressionStatement() : this.parseFnDecl()
      case 'return':
        return this.parseReturn()
      case 'break':
      case 'continue':
        this.next()
        return this.node({
          kind: token.kind === 'break' ? 'Break' : 'Continue',
          span: span(token.start, token.end),
        })
      case 'while':
        return this.parseWhile()
      case 'for':
        return this.parseFor()
      case '{': {
        const block = this.parseBlock()
        return this.node({ kind: 'BlockStmt', block, span: block.span })
      }
      default:
        return this.parseExpressionStatement()
    }
  }

  /** `( "let" | "var" ) pattern "=" expr`. */
  private parseLet(): Stmt {
    const keyword = this.next()
    this.enter()
    const { pattern, binders } = this.parseCheckedPattern('binding')
    this.checkDuplicateBindings(binders)
    this.expect('=')
    const init = this.parseExpr()
    this.leave()
    const mutable = keyword.kind === 'var'
    return this.node({ kind: 'Let', mutable, pattern, init, span: this.spanFrom(keyword.start) })
  }

  /** `"fn" IDENT "(" [ params ] ")" block`. */
  private parseFnDecl(): Stmt {
    const keyword = this.next()
    const nameToken = this.peek()
    if (nameToken.kind !== 'Identifier') return this.failExpected('an identifier')
    this.next()
    if (!this.at('(')) return this.failExpected("'('")
    const name = String(nameToken.value)
    this.enter()
    const fn = this.parseFunctionTail(keyword.start, name)
    this.leave()
    const nameSpan = span(nameToken.start, nameToken.end)
    return this.node({ kind: 'FnDecl', name, nameSpan, fn, span: this.spanFrom(keyword.start) })
  }

  /** `"return" [ expr ]`: a value only when it starts on the same line (SPEC §3.2 rule 4). */
  private parseReturn(): Stmt {
    const keyword = this.next()
    const token = this.peek()
    const hasValue =
      !token.newlineBefore && token.kind !== '}' && token.kind !== ';' && token.kind !== 'EOF'
    let value: Expr | null = null
    if (hasValue) {
      this.enter()
      value = this.parseExpr()
      this.leave()
    }
    return this.node({ kind: 'Return', value, span: this.spanFrom(keyword.start) })
  }

  private parseWhile(): Stmt {
    const keyword = this.next()
    this.enter()
    const cond = this.parseExpr()
    const body = this.parseBlock()
    this.leave()
    return this.node({ kind: 'While', cond, body, span: this.spanFrom(keyword.start) })
  }

  /** `"for" pattern "in" expr block`. */
  private parseFor(): Stmt {
    const keyword = this.next()
    this.enter()
    const { pattern, binders } = this.parseCheckedPattern('binding')
    this.checkDuplicateBindings(binders)
    this.expect('in')
    const iterable = this.parseExpr()
    const headerSpan = this.spanFrom(keyword.start)
    const body = this.parseBlock()
    this.leave()
    const forStmt = {
      kind: 'For',
      pattern,
      iterable,
      body,
      headerSpan,
      span: this.spanFrom(keyword.start),
    } as const
    return this.node(forStmt)
  }

  /** `expr [ assignOp expr ]`. An invalid target is E012 and leaves an expression statement. */
  private parseExpressionStatement(): Stmt {
    const start = this.peek().start
    this.enter()
    const target = this.parseExpr()
    const op = this.peek()
    if (!ASSIGN_OPS.has(op.kind) || this.blockedByNewline(op)) {
      this.leave()
      return this.node({ kind: 'ExprStmt', expr: target, span: this.spanFrom(start) })
    }
    const targetSpan = this.spanFrom(start)
    this.next()
    const value = this.parseExpr()
    this.leave()
    const whole = this.spanFrom(start)
    if (
      target.kind === 'Member' ||
      target.kind === 'Index' ||
      (target.kind === 'Ident' && target.name !== '_')
    ) {
      // Every token kind in ASSIGN_OPS is an AssignOp.
      return this.node({ kind: 'Assign', op: op.kind as AssignOp, target, value, span: whole })
    }
    if (target.kind === 'Ident') this.withdrawWildcardUse(target.span.start)
    this.check('E012', 'invalid assignment target', targetSpan)
    return this.node({ kind: 'ExprStmt', expr: target, span: whole })
  }

  /** `_` directly as an assignment target is E012 only, not also E027 (SPEC §3.6). */
  private withdrawWildcardUse(offset: number): void {
    this.checks = this.checks.filter((d) => d.code !== 'E027' || d.span.start !== offset)
  }
}
