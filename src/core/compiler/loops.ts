/** Loops, `break` and `continue` (SPEC §8.2–8.4, ARCHITECTURE §4.3.3). */
import type { BreakStmt, ContinueStmt, ForStmt, WhileStmt } from '../ast'
import { Op } from '../bytecode'
import { diagnostic } from '../diagnostics'
import { span } from '../span'
import type { Span } from '../span'
import { compileExpr } from './expressions'
import type { FunctionState, LoopContext } from './function-state'
import { bindLocalPattern, closingBrace, compileBlock } from './statements'

export function compileWhile(fs: FunctionState, stmt: WhileStmt): void {
  const bodyDepth = fs.depth
  const loop: LoopContext = { bodyDepth, continueTarget: fs.ip, breakJumps: [] }
  fs.loops.push(loop)
  compileExpr(fs, stmt.cond)
  const exit = fs.emitJump(Op.JumpIfFalse, stmt.cond.span)
  compileBlock(fs, stmt.body, 'stmt')
  fs.emit(Op.Jump, [loop.continueTarget], stmt.cond.span)
  fs.loops.pop()
  fs.patchJump(exit)
  for (const jump of loop.breakJumps) fs.patchJump(jump)
}

export function compileFor(fs: FunctionState, stmt: ForStmt): void {
  const header = stmt.headerSpan
  const iterSlot = fs.depth
  compileExpr(fs, stmt.iterable)
  fs.emit(Op.IterInit, [], header)
  const iterStart = fs.ip
  const loop: LoopContext = { bodyDepth: iterSlot + 1, continueTarget: fs.ip, breakJumps: [] }
  fs.loops.push(loop)
  fs.markStmtStart()
  const exit = fs.emitJump(Op.IterNext, header)
  fs.pushScope(iterSlot + 1)
  bindLocalPattern(fs, stmt.pattern, { kind: 'loop', mutable: false, declareSpan: header })
  compileBlock(fs, stmt.body, 'stmt')
  fs.closeScope('stmt', closingBrace(stmt.body))
  fs.emit(Op.Jump, [loop.continueTarget], header)
  fs.loops.pop()
  fs.patchJump(exit)
  for (const jump of loop.breakJumps) fs.patchJump(jump)
  fs.emit(Op.Pop, [], header)
  const iter = { name: '$iter', slot: iterSlot, kind: 'hidden', mutable: false } as const
  fs.recordLocal({ ...iter, declSpan: header, startIp: iterStart }, iterStart, fs.ip, true)
}

/** `PopN (depth − bodyDepth)` then a jump; the depth after it is tracked as if unchanged. */
function leaveIteration(fs: FunctionState, loop: LoopContext, keyword: Span): number {
  const depth = fs.depth
  const count = depth - loop.bodyDepth
  if (count > 0) fs.emit(Op.PopN, [count], keyword)
  return depth
}

export function compileBreak(fs: FunctionState, stmt: BreakStmt): void {
  const keyword = span(stmt.span.start, stmt.span.start + 'break'.length)
  const loop = fs.loops[fs.loops.length - 1]
  if (loop === undefined) {
    fs.ctx.report(diagnostic('E024', "'break' can only be used inside a loop", keyword))
    return
  }
  const depth = leaveIteration(fs, loop, keyword)
  loop.breakJumps.push(fs.emitJump(Op.Jump, keyword))
  fs.depth = depth
}

export function compileContinue(fs: FunctionState, stmt: ContinueStmt): void {
  const keyword = span(stmt.span.start, stmt.span.start + 'continue'.length)
  const loop = fs.loops[fs.loops.length - 1]
  if (loop === undefined) {
    fs.ctx.report(diagnostic('E024', "'continue' can only be used inside a loop", keyword))
    return
  }
  const depth = leaveIteration(fs, loop, keyword)
  fs.emit(Op.Jump, [loop.continueTarget], keyword)
  fs.depth = depth
}
