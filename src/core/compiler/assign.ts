/** Assignment statements (SPEC §5.5, ARCHITECTURE §4.3.3). */
import type { AssignOp, AssignStmt, Ident, Index, Member } from '../ast'
import type { OpCode } from '../bytecode'
import { Op } from '../bytecode'
import { compileExpr } from './expressions'
import type { FunctionState } from './function-state'
import { checkAssignable, emitGet, emitSet, resolveReference } from './resolve'

const COMPOUND_OPS: Readonly<Record<Exclude<AssignOp, '='>, OpCode>> = {
  '+=': Op.Add,
  '-=': Op.Sub,
  '*=': Op.Mul,
  '/=': Op.Div,
  '%=': Op.Mod,
}

/** The arithmetic opcode of a compound assignment, or null for plain `=`. */
function compoundOp(op: AssignOp): OpCode | null {
  return op === '=' ? null : COMPOUND_OPS[op]
}

function assignVariable(fs: FunctionState, stmt: AssignStmt, target: Ident): void {
  const resolution = resolveReference(fs, target.name, target.span)
  checkAssignable(fs, resolution, target.name, target.span)
  const op = compoundOp(stmt.op)
  if (op !== null) emitGet(fs, resolution, target.name, target.span)
  compileExpr(fs, stmt.value)
  if (op !== null) fs.emit(op, [], stmt.span)
  emitSet(fs, resolution, target.name, target.span)
}

function assignField(fs: FunctionState, stmt: AssignStmt, target: Member): void {
  const name = fs.constantFor(target.name)
  compileExpr(fs, target.object)
  const op = compoundOp(stmt.op)
  if (op !== null) {
    fs.emit(Op.Dup, [], target.span)
    fs.emit(Op.GetField, [name], target.accessSpan)
  }
  compileExpr(fs, stmt.value)
  if (op !== null) fs.emit(op, [], stmt.span)
  fs.emit(Op.SetField, [name], target.accessSpan)
}

function assignIndex(fs: FunctionState, stmt: AssignStmt, target: Index): void {
  compileExpr(fs, target.object)
  compileExpr(fs, target.index)
  const op = compoundOp(stmt.op)
  if (op !== null) {
    fs.emit(Op.Dup2, [], target.span)
    fs.emit(Op.GetIndex, [], target.span)
  }
  compileExpr(fs, stmt.value)
  if (op !== null) fs.emit(op, [], stmt.span)
  fs.emit(Op.SetIndex, [], target.span)
}

export function compileAssign(fs: FunctionState, stmt: AssignStmt): void {
  const target = stmt.target
  switch (target.kind) {
    case 'Ident':
      return assignVariable(fs, stmt, target)
    case 'Member':
      return assignField(fs, stmt, target)
    case 'Index':
      return assignIndex(fs, stmt, target)
  }
}
