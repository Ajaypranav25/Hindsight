/** Expressions (ARCHITECTURE §4.3.3); spans per §4.3.5 / SPEC §10.4. */
import type {
  Binary,
  Call,
  Expr,
  IfExpr,
  ListLit,
  Logical,
  RecordField,
  RecordLit,
  Spread,
  TemplateLit,
} from '../ast'
import type { OpCode } from '../bytecode'
import { Op } from '../bytecode'
import type { FunctionState } from './function-state'
import { compileFunction } from './functions'
import { compileMatch } from './match'
import { emitGet, resolveReference } from './resolve'
import { compileBlock } from './statements'

const BINARY_OPS: Readonly<Record<string, OpCode>> = {
  '+': Op.Add,
  '-': Op.Sub,
  '*': Op.Mul,
  '/': Op.Div,
  '%': Op.Mod,
  '**': Op.Pow,
  '==': Op.Eq,
  '!=': Op.Ne,
  '<': Op.Lt,
  '<=': Op.Le,
  '>': Op.Gt,
  '>=': Op.Ge,
}

function compileBinary(fs: FunctionState, expr: Binary): void {
  compileExpr(fs, expr.left)
  compileExpr(fs, expr.right)
  if (expr.op === '..' || expr.op === '..=') {
    fs.emit(Op.Range, [expr.op === '..=' ? 1 : 0], expr.span)
    return
  }
  fs.emit(BINARY_OPS[expr.op]!, [], expr.span)
}

function compileLogical(fs: FunctionState, expr: Logical): void {
  compileExpr(fs, expr.left)
  const jump = fs.emitJump(expr.op === 'and' ? Op.AndJump : Op.OrJump, expr.span)
  compileExpr(fs, expr.right)
  fs.patchJump(jump)
}

function compileIf(fs: FunctionState, expr: IfExpr): void {
  compileExpr(fs, expr.cond)
  const toElse = fs.emitJump(Op.JumpIfFalse, expr.span)
  compileBlock(fs, expr.then, 'value')
  const toEnd = fs.emitJump(Op.Jump, expr.span)
  fs.depth -= 1
  fs.patchJump(toElse)
  const otherwise = expr.else
  if (otherwise === null) fs.emit(Op.Nil, [], expr.span)
  else if (otherwise.kind === 'Block') compileBlock(fs, otherwise, 'value')
  else compileIf(fs, otherwise)
  fs.patchJump(toEnd)
}

function compileTemplate(fs: FunctionState, expr: TemplateLit): void {
  let count = 0
  expr.quasis.forEach((quasi, i) => {
    if (quasi !== '') {
      fs.emit(Op.Const, [fs.constantFor(quasi)], expr.span)
      count++
    }
    const part = expr.exprs[i]
    if (part !== undefined) {
      compileExpr(fs, part)
      count++
    }
  })
  fs.emit(Op.Interp, [count], expr.span)
}

function leadingPlainCount<T>(items: readonly (T | Spread)[]): number {
  const firstSpread = items.findIndex((item) => (item as Spread).kind === 'Spread')
  return firstSpread < 0 ? items.length : firstSpread
}

function compileList(fs: FunctionState, expr: ListLit): void {
  const leading = leadingPlainCount(expr.items)
  expr.items.slice(0, leading).forEach((item) => compileExpr(fs, item as Expr))
  fs.emit(Op.List, [leading], expr.span)
  for (const item of expr.items.slice(leading)) {
    if (item.kind === 'Spread') {
      compileExpr(fs, item.expr)
      fs.emit(Op.ListExtend, [], item.span)
    } else {
      compileExpr(fs, item)
      fs.emit(Op.ListAppend, [], item.span)
    }
  }
}

function compileField(fs: FunctionState, field: RecordField): void {
  fs.emit(Op.Const, [fs.constantFor(field.key)], field.keySpan)
  compileExpr(fs, field.value)
}

function compileRecord(fs: FunctionState, expr: RecordLit): void {
  const leading = leadingPlainCount(expr.items)
  expr.items.slice(0, leading).forEach((item) => compileField(fs, item as RecordField))
  fs.emit(Op.Record, [leading], expr.span)
  for (const item of expr.items.slice(leading)) {
    if (item.kind === 'Spread') {
      compileExpr(fs, item.expr)
      fs.emit(Op.RecordMerge, [], item.span)
    } else {
      compileField(fs, item)
      fs.emit(Op.RecordSet, [], item.span)
    }
  }
}

function compileCall(fs: FunctionState, expr: Call): void {
  compileExpr(fs, expr.callee)
  for (const arg of expr.args) compileExpr(fs, arg)
  fs.emit(
    Op.Call,
    [expr.args.length],
    expr.pipe && expr.pipeSpan !== null ? expr.pipeSpan : expr.span,
  )
}

/**
 * Compiles an expression, leaving its value on the stack. `nameHint` is the display name for a
 * function that is the entire initializer of `let NAME =` (SPEC §7.12).
 */
export function compileExpr(fs: FunctionState, expr: Expr, nameHint: string | null = null): void {
  switch (expr.kind) {
    case 'Number':
    case 'String':
      fs.emit(Op.Const, [fs.constantFor(expr.value)], expr.span)
      return
    case 'Bool':
      fs.emit(expr.value ? Op.True : Op.False, [], expr.span)
      return
    case 'Nil':
      fs.emit(Op.Nil, [], expr.span)
      return
    case 'Template':
      return compileTemplate(fs, expr)
    case 'Ident':
      emitGet(fs, resolveReference(fs, expr.name, expr.span), expr.name, expr.span)
      return
    case 'List':
      return compileList(fs, expr)
    case 'Record':
      return compileRecord(fs, expr)
    case 'Unary':
      compileExpr(fs, expr.operand)
      fs.emit(expr.op === '-' ? Op.Neg : Op.Not, [], expr.span)
      return
    case 'Binary':
      return compileBinary(fs, expr)
    case 'Logical':
      return compileLogical(fs, expr)
    case 'Call':
      return compileCall(fs, expr)
    case 'Index':
      compileExpr(fs, expr.object)
      compileExpr(fs, expr.index)
      fs.emit(Op.GetIndex, [], expr.span)
      return
    case 'Member':
      compileExpr(fs, expr.object)
      fs.emit(Op.GetField, [fs.constantFor(expr.name)], expr.accessSpan)
      return
    case 'Function':
      return compileFunction(fs, expr, expr.name ?? nameHint)
    case 'If':
      return compileIf(fs, expr)
    case 'Match':
      return compileMatch(fs, expr)
  }
}
