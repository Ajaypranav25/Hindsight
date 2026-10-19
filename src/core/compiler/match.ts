/** `match` expressions (SPEC §7.14, ARCHITECTURE §4.3.3). */
import type { MatchArm, MatchExpr } from '../ast'
import { Op } from '../bytecode'
import { compileExpr } from './expressions'
import type { FunctionState } from './function-state'
import { compilePattern } from './patterns'
import { closingBrace, compileBlock } from './statements'

/**
 * `L_i: MatchPattern k L_{i+1}; Declare m; guard? (guard; JumpIfFalse L_gf); body; EndScope m;
 * Jump L_end; L_gf: PopN m`. Each binding of a guarded arm gets a second live range covering the
 * guard-failure `PopN`.
 */
function compileArm(
  fs: FunctionState,
  arm: MatchArm,
  subjectSlot: number,
  endJumps: number[],
): void {
  const compiled = compilePattern(arm.pattern, fs.ctx.source)
  const count = compiled.bindings.length
  fs.markStmtStart()
  const next = fs.emitJump(Op.MatchPattern, arm.pattern.span, [fs.addConstant(compiled.constant)])
  fs.pushScope(subjectSlot + 1)
  if (count > 0) {
    fs.emit(Op.Declare, [count], arm.pattern.span)
    compiled.bindings.forEach((b, i) => {
      const slot = subjectSlot + 1 + i
      fs.declare({
        name: b.name,
        slot,
        kind: 'match',
        mutable: false,
        declSpan: b.span,
        startIp: fs.ip,
      })
    })
  }
  const guard = arm.guard
  let guardFail = -1
  if (guard !== null) {
    compileExpr(fs, guard)
    guardFail = fs.emitJump(Op.JumpIfFalse, guard.span)
  }
  fs.markStmtStart()
  if (arm.body.kind === 'Block') compileBlock(fs, arm.body, 'value')
  else compileExpr(fs, arm.body)
  const bindings = fs.closeScope('value', arm.span)
  endJumps.push(fs.emitJump(Op.Jump, arm.span))
  if (guard !== null) {
    fs.depth = subjectSlot + 1 + count
    fs.patchJump(guardFail)
    if (count > 0) {
      const failIp = fs.ip
      fs.emit(Op.PopN, [count], guard.span)
      for (const binding of bindings) fs.recordLocal(binding, failIp, fs.ip)
    }
  }
  fs.depth = subjectSlot + 1
  fs.patchJump(next)
}

export function compileMatch(fs: FunctionState, match: MatchExpr): void {
  const subjectSlot = fs.depth
  compileExpr(fs, match.subject)
  const subjectStart = fs.ip
  const endJumps: number[] = []
  for (const arm of match.arms) {
    fs.withStmtSpan(arm.span, () => compileArm(fs, arm, subjectSlot, endJumps))
  }
  fs.emit(Op.NoMatch, [], match.subject.span)
  fs.depth = subjectSlot + 2
  for (const jump of endJumps) fs.patchJump(jump)
  fs.emit(Op.EndScope, [1], closingBrace(match))
  const subject = {
    name: '$subject',
    slot: subjectSlot,
    kind: 'hidden',
    mutable: false,
    declSpan: match.subject.span,
    startIp: subjectStart,
  } as const
  fs.recordLocal(subject, subjectStart, fs.ip, true)
}
