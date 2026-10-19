/**
 * Statements and blocks (ARCHITECTURE §4.3.3): expression statements, declarations, blocks, and the
 * dispatch to assignments, loops and jumps.
 */
import type { Block, FnDecl, LetStmt, Pattern, ReturnStmt, Stmt } from '../ast'
import { Op } from '../bytecode'
import { builtinIndex, isLibraryIndex } from '../builtin-names'
import { diagnostic, InternalError } from '../diagnostics'
import { span } from '../span'
import type { Span } from '../span'
import type { LocalKind } from '../bytecode'
import { compileAssign } from './assign'
import { compileExpr } from './expressions'
import type { BlockMode, FunctionState } from './function-state'
import { compileFunction } from './functions'
import { compileBreak, compileContinue, compileFor, compileWhile } from './loops'
import { compilePattern } from './patterns'

/** The 1-character span of a block's closing `}`. */
export function closingBrace(block: { readonly span: Span }): Span {
  return span(block.span.end - 1, block.span.end)
}

/** Compiles a block as a nested scope; in value mode its value stays on the stack. */
export function compileBlock(fs: FunctionState, block: Block, mode: BlockMode): void {
  fs.pushScope()
  const body = block.body
  const last = body[body.length - 1]
  body.forEach((stmt, i) => compileStmt(fs, stmt, mode === 'value' && i === body.length - 1))
  if (mode === 'value' && last?.kind !== 'ExprStmt') fs.emit(Op.Nil, [], closingBrace(block))
  fs.closeScope(mode, closingBrace(block))
}

/**
 * Compiles a statement. `keepValue` leaves an expression statement's value on the stack (the last
 * statement of a value-mode block).
 */
export function compileStmt(fs: FunctionState, stmt: Stmt, keepValue = false): void {
  fs.withStmtSpan(stmt.span, () => {
    fs.markStmtStart()
    compileStmtBody(fs, stmt, keepValue)
    fs.clearStmtStart()
  })
}

function compileStmtBody(fs: FunctionState, stmt: Stmt, keepValue: boolean): void {
  if (fs.atTopLevel && fs.ctx.mode === 'library' && stmt.kind !== 'FnDecl') {
    throw new InternalError(`library code may only declare functions, found ${stmt.kind}`)
  }
  switch (stmt.kind) {
    case 'ExprStmt':
      compileExpr(fs, stmt.expr)
      if (!keepValue) fs.emit(Op.Pop, [], stmt.span)
      return
    case 'Let':
      return compileLet(fs, stmt)
    case 'FnDecl':
      return compileFnDecl(fs, stmt)
    case 'Assign':
      return compileAssign(fs, stmt)
    case 'Return':
      return compileReturn(fs, stmt)
    case 'Break':
      return compileBreak(fs, stmt)
    case 'Continue':
      return compileContinue(fs, stmt)
    case 'While':
      return compileWhile(fs, stmt)
    case 'For':
      return compileFor(fs, stmt)
    case 'BlockStmt':
      return compileBlock(fs, stmt.block, 'stmt')
  }
}

export interface BindOptions {
  readonly kind: LocalKind
  readonly mutable: boolean
  /** Span of the `Declare` instruction. */
  readonly declareSpan: Span
}

/**
 * Binds the value on top of the stack to a local pattern: `Declare 1` for a name, `Pop` for `_`,
 * otherwise `Destructure k; Declare m` (the `Declare` omitted when nothing is bound).
 */
export function bindLocalPattern(fs: FunctionState, pattern: Pattern, options: BindOptions): void {
  if (pattern.kind === 'PWildcard') {
    fs.emit(Op.Pop, [], pattern.span)
    return
  }
  const { kind, mutable } = options
  if (pattern.kind === 'PBind') {
    const slot = fs.depth - 1
    fs.emit(Op.Declare, [1], options.declareSpan)
    fs.declare({ name: pattern.name, slot, kind, mutable, declSpan: pattern.span, startIp: fs.ip })
    return
  }
  const compiled = compilePattern(pattern, fs.ctx.source)
  fs.emit(Op.Destructure, [fs.addConstant(compiled.constant)], pattern.span)
  const count = compiled.bindings.length
  if (count === 0) return
  const first = fs.depth - count
  fs.emit(Op.Declare, [count], options.declareSpan)
  compiled.bindings.forEach((b, i) => {
    fs.declare({ name: b.name, slot: first + i, kind, mutable, declSpan: b.span, startIp: fs.ip })
  })
}

function compileLet(fs: FunctionState, stmt: LetStmt): void {
  const pattern = stmt.pattern
  const nameHint = pattern.kind === 'PBind' ? pattern.name : null
  compileExpr(fs, stmt.init, nameHint)
  if (!fs.atTopLevel || pattern.kind === 'PWildcard') {
    const kind = stmt.mutable ? 'var' : 'let'
    bindLocalPattern(fs, pattern, { kind, mutable: stmt.mutable, declareSpan: stmt.span })
    return
  }
  if (pattern.kind === 'PBind') {
    fs.emit(Op.DefineGlobal, [fs.constantFor(pattern.name)], stmt.span)
    return
  }
  const compiled = compilePattern(pattern, fs.ctx.source)
  fs.emit(Op.Destructure, [fs.addConstant(compiled.constant)], pattern.span)
  for (let i = compiled.bindings.length - 1; i >= 0; i--) {
    fs.emit(Op.DefineGlobal, [fs.constantFor(compiled.bindings[i]!.name)], stmt.span)
  }
}

function compileFnDecl(fs: FunctionState, stmt: FnDecl): void {
  if (!fs.atTopLevel) {
    // Declared first so the body can capture its own slot (Closure pushes before capturing).
    const binding = fs.declare({
      name: stmt.name,
      slot: fs.depth,
      kind: 'fn',
      mutable: false,
      declSpan: stmt.nameSpan,
      startIp: -1,
    })
    compileFunction(fs, stmt.fn, stmt.name)
    fs.emit(Op.Declare, [1], stmt.span)
    binding.startIp = fs.ip
    return
  }
  compileFunction(fs, stmt.fn, stmt.name)
  if (fs.ctx.mode === 'main') {
    fs.emit(Op.DefineGlobal, [fs.constantFor(stmt.name)], stmt.span)
    return
  }
  const index = builtinIndex(stmt.name)
  if (!isLibraryIndex(index)) throw new InternalError(`'${stmt.name}' is not a library builtin`)
  fs.emit(Op.DefineBuiltin, [index], stmt.span)
}

function compileReturn(fs: FunctionState, stmt: ReturnStmt): void {
  const keyword = span(stmt.span.start, stmt.span.start + 'return'.length)
  if (fs.isScript) {
    fs.ctx.report(diagnostic('E025', "'return' can only be used inside a function", keyword))
  }
  if (stmt.value === null) fs.emit(Op.Nil, [], keyword)
  else compileExpr(fs, stmt.value)
  fs.emit(Op.Return, [], stmt.span)
}
