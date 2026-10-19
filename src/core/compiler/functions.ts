/**
 * Functions and lambdas (ARCHITECTURE §4.3.3): a separate `FunctionProto` per function, parameter
 * prologues for pattern parameters, and `Closure k (isLocal, index)…` in the enclosing function.
 */
import type { Block, Expr, FunctionExpr, Pattern } from '../ast'
import { Op } from '../bytecode'
import { compileExpr } from './expressions'
import { FunctionState } from './function-state'
import { bindLocalPattern, closingBrace, compileBlock } from './statements'

function isPlainParameter(param: Pattern): boolean {
  return param.kind === 'PBind' || param.kind === 'PWildcard'
}

/** Identifier parameters occupy their slots directly. */
function declareParameters(fs: FunctionState, params: readonly Pattern[]): void {
  params.forEach((param, i) => {
    if (param.kind !== 'PBind') return
    fs.declare({
      name: param.name,
      slot: 1 + i,
      kind: 'param',
      mutable: false,
      declSpan: param.span,
      startIp: 0,
    })
  })
}

/** For each pattern parameter: `GetLocal 1+i; Destructure k; Declare m` (a statement start). */
function compilePrologue(fs: FunctionState, params: readonly Pattern[]): void {
  params.forEach((param, i) => {
    if (isPlainParameter(param)) return
    fs.withStmtSpan(param.span, () => {
      fs.markStmtStart()
      fs.emit(Op.GetLocal, [1 + i], param.span)
      bindLocalPattern(fs, param, { kind: 'param', mutable: false, declareSpan: param.span })
    })
  })
}

/** Every parameter that is not an identifier lives in a hidden `$argI` slot for the whole body. */
function recordHiddenParameters(fs: FunctionState, params: readonly Pattern[]): void {
  params.forEach((param, i) => {
    if (param.kind === 'PBind') return
    const binding = {
      name: `$arg${i}`,
      slot: 1 + i,
      kind: 'param',
      mutable: false,
      declSpan: param.span,
      startIp: 0,
    } as const
    fs.recordLocal(binding, 0, fs.ip, true)
  })
}

function compileBody(fs: FunctionState, body: Block | Expr): void {
  if (body.kind === 'Block') {
    compileBlock(fs, body, 'value')
    fs.emit(Op.Return, [], closingBrace(body))
    return
  }
  fs.markStmtStart()
  compileExpr(fs, body)
  fs.emit(Op.Return, [], body.span)
}

/** Compiles `fn` as a nested proto and emits its `Closure` in `fs`. */
export function compileFunction(fs: FunctionState, fn: FunctionExpr, name: string | null): void {
  const body = fn.body
  const child = new FunctionState(fs.ctx, fs, {
    name,
    kind: 'function',
    arity: fn.params.length,
    span: fn.span,
    baseStmtSpan: body.kind === 'Block' ? closingBrace(body) : body.span,
  })
  child.pushScope()
  declareParameters(child, fn.params)
  compilePrologue(child, fn.params)
  compileBody(child, body)
  recordHiddenParameters(child, fn.params)
  const proto = child.finish()
  const operands = [fs.addConstant(proto)]
  for (const upvalue of child.upvalues) operands.push(upvalue.isLocal ? 1 : 0, upvalue.index)
  fs.emit(Op.Closure, operands, fn.span)
}
