/**
 * Function contracts (SPEC §7.16, ARCHITECTURE §4.3.3). A `requires` clause runs at entry, after
 * the parameter prologue: `clause; Check k`. Every return (each `return` statement and the end of
 * the body) runs the `ensures` clauses with the returned value bound to `result`:
 * `Declare 1; clause; Check k; …; Return`. Clauses see the parameters (and, in `ensures`,
 * `result`) but none of the body's locals, and no loop around a `return`. A function without
 * `ensures` clauses returns with a bare `Return`, so contract-free code is unchanged.
 */
import type { ContractClause, FunctionExpr } from '../ast'
import { type ContractConst, Op } from '../bytecode'
import { diagnostic } from '../diagnostics'
import type { Span } from '../span'
import { compileExpr } from './expressions'
import type { Binding, FunctionState } from './function-state'

/** The name `ensures` clauses use for the returned value. */
export const RESULT_NAME = 'result'

/** The contract data `Check` raises with (R026/R027). */
function contractConstant(
  fs: FunctionState,
  fn: FunctionExpr,
  name: string | null,
  clause: ContractClause,
): ContractConst {
  const source = fs.ctx.source
  return {
    tag: 'contract',
    kind: clause.clause,
    text: source.slice(clause.expr.span.start, clause.expr.span.end),
    fn: name ?? 'lambda',
    params: fn.params.map((param) => source.slice(param.span.start, param.span.end)),
  }
}

/** A compiled clause waiting at every place it applies: its constant index and its syntax. */
export interface PreparedClause {
  readonly clause: ContractClause
  readonly constant: number
}

/** Adds each clause's constant once; returns the `requires` and the `ensures` clauses. */
export function prepareContracts(
  fs: FunctionState,
  fn: FunctionExpr,
  name: string | null,
): { readonly requires: PreparedClause[]; readonly ensures: PreparedClause[] } {
  const requires: PreparedClause[] = []
  const ensures: PreparedClause[] = []
  for (const clause of fn.contracts) {
    const constant = fs.addConstant(contractConstant(fs, fn, name, clause))
    ;(clause.clause === 'requires' ? requires : ensures).push({ clause, constant })
  }
  return { requires, ensures }
}

/** `clause; Check k`, a statement start of its own whose spans are the clause expression. */
function compileClause(fs: FunctionState, prepared: PreparedClause): void {
  const expr = prepared.clause.expr
  fs.withStmtSpan(expr.span, () => {
    fs.markStmtStart()
    compileExpr(fs, expr)
    fs.emit(Op.Check, [prepared.constant], expr.span)
  })
}

/** The preconditions, in order, at function entry (after the parameter prologue). */
export function compileRequires(fs: FunctionState, clauses: readonly PreparedClause[]): void {
  if (clauses.length === 0) return
  fs.withContractView(null, () => {
    for (const clause of clauses) compileClause(fs, clause)
  })
}

/**
 * Returns the value on top of the stack: first the postconditions with that value declared as
 * `result` (a local visible to the inspector while they run), then `Return`. `declareSpan` is the
 * `return` statement, or the body's closing brace for the implicit return.
 */
export function emitReturn(fs: FunctionState, returnSpan: Span, declareSpan: Span): void {
  const clauses = fs.ensures
  if (clauses.length === 0) {
    fs.emit(Op.Return, [], returnSpan)
    return
  }
  fs.emit(Op.Declare, [1], declareSpan)
  const result: Binding = {
    name: RESULT_NAME,
    slot: fs.depth - 1,
    kind: 'result',
    mutable: false,
    declSpan: clauses[0]!.clause.expr.span,
    startIp: fs.ip,
  }
  fs.withContractView(result, () => {
    for (const clause of clauses) compileClause(fs, clause)
  })
  fs.emit(Op.Return, [], returnSpan)
  fs.recordLocal(result, result.startIp, fs.ip)
}

/** E029: a clause is an expression; it cannot leave the function (SPEC §7.16). */
export function reportReturnInContract(fs: FunctionState, keyword: Span): void {
  fs.ctx.report(diagnostic('E029', "'return' cannot be used in a contract", keyword))
}
