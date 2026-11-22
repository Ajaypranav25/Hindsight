/**
 * What the contract oracle reads from the syntax tree (ARCHITECTURE §7.6): the functions whose
 * postconditions pin their result down (`ensures result == EXPR`), and the assertions written as
 * examples (`assert(F(args) == EXPECTED)`). One iterative walk over the tree (no recursion).
 */
import type * as ast from './ast'
import type { Span } from './span'

/**
 * An `assert(F(args) == EXPECTED)` (either side): it judges the call of F made inside it. Neither
 * EXPECTED nor the arguments may mention F, or the assertion would not pin the result down.
 */
export interface AssertionExample {
  /** The `assert(...)` call expression: the span of its `Call` and of its R018. */
  readonly assertSpan: Span
  /** The span of the `F(args)` call's `Call` instruction (its `pipeSpan` when piped). */
  readonly siteSpan: Span
  /** The called function's name, as written. */
  readonly callee: string
}

export interface OracleSyntax {
  /** By function span (`start:end`, the proto's `debug.span`): the clause that pins its result. */
  readonly pinned: ReadonlyMap<string, ast.ContractClause>
  readonly assertions: readonly AssertionExample[]
}

export type SyntaxNode =
  ast.Stmt | ast.Expr | ast.Block | ast.Spread | ast.RecordField | ast.MatchArm | ast.ContractClause
type Node = SyntaxNode

export function spanKey(span: Span): string {
  return `${span.start}:${span.end}`
}

/** The functions with a pinning postcondition and the assertion examples of `program`. */
export function scanOracleSyntax(program: ast.Program): OracleSyntax {
  const pinned = new Map<string, ast.ContractClause>()
  const assertions: AssertionExample[] = []
  const work: Node[] = [...program.body]
  for (let node = work.pop(); node !== undefined; node = work.pop()) {
    if (node.kind === 'Function') {
      const clause = node.contracts.find((c) => c.clause === 'ensures' && pinsResult(c.expr))
      if (clause !== undefined) pinned.set(spanKey(node.span), clause)
    } else if (node.kind === 'Call') {
      const example = assertionExample(node)
      if (example !== null) assertions.push(example)
    }
    for (const child of childrenOf(node)) work.push(child)
  }
  return { pinned, assertions }
}

/** True when a top-level conjunct of `expr` is `result == EXPR` (either side, EXPR without result). */
export function pinsResult(expr: ast.Expr): boolean {
  const conjuncts: ast.Expr[] = [expr]
  for (let node = conjuncts.pop(); node !== undefined; node = conjuncts.pop()) {
    if (node.kind === 'Logical' && node.op === 'and') {
      conjuncts.push(node.left, node.right)
    } else if (node.kind === 'Binary' && node.op === '==') {
      if (isResult(node.left) && !mentions(node.right, 'result')) return true
      if (isResult(node.right) && !mentions(node.left, 'result')) return true
    }
  }
  return false
}

function isResult(expr: ast.Expr): boolean {
  return expr.kind === 'Ident' && expr.name === 'result'
}

/** Whether any identifier in `expr` (functions inside it included) is `name`. */
function mentions(expr: ast.Expr, name: string): boolean {
  const work: Node[] = [expr]
  for (let node = work.pop(); node !== undefined; node = work.pop()) {
    if (node.kind === 'Ident' && node.name === name) return true
    for (const child of childrenOf(node)) work.push(child)
  }
  return false
}

function assertionExample(call: ast.Call): AssertionExample | null {
  if (call.callee.kind !== 'Ident' || call.callee.name !== 'assert' || call.args.length === 0) {
    return null
  }
  const condition = call.args[0]!
  if (condition.kind !== 'Binary' || condition.op !== '==') return null
  const judged = [condition.left, condition.right].find(
    (side): side is ast.Call => side.kind === 'Call' && side.callee.kind === 'Ident',
  )
  if (judged === undefined || judged.callee.kind !== 'Ident') return null
  // The expectation must not depend on the function judged: `assert(f(2) == f(1) + 1)` or
  // `assert(f(f(1)) == 4)` relates calls of f to each other and passes for many wrong f.
  const expected = judged === condition.left ? condition.right : condition.left
  const name = judged.callee.name
  if (mentions(expected, name) || judged.args.some((arg) => mentions(arg, name))) return null
  return {
    assertSpan: call.span,
    siteSpan: judged.pipe && judged.pipeSpan !== null ? judged.pipeSpan : judged.span,
    callee: judged.callee.name,
  }
}

/** The direct children of a node that can contain expressions, statements or functions. */
export function childrenOf(node: Node): readonly Node[] {
  switch (node.kind) {
    case 'ExprStmt':
      return [node.expr]
    case 'Let':
      return [node.init]
    case 'FnDecl':
      return [node.fn]
    case 'Assign':
      return [node.target, node.value]
    case 'Return':
      return node.value === null ? [] : [node.value]
    case 'While':
      return [node.cond, node.body]
    case 'For':
      return [node.iterable, node.body]
    case 'BlockStmt':
      return [node.block]
    case 'Block':
      return node.body
    case 'Break':
    case 'Continue':
      return []
    default:
      return expressionChildren(node)
  }
}

function expressionChildren(node: Exclude<Node, ast.Stmt | ast.Block>): readonly Node[] {
  switch (node.kind) {
    case 'Template':
      return node.exprs
    case 'List':
    case 'Record':
      return node.items
    case 'Spread':
      return [node.expr]
    case 'Field':
      return [node.value]
    case 'Unary':
      return [node.operand]
    case 'Binary':
    case 'Logical':
      return [node.left, node.right]
    case 'Call':
      return [node.callee, ...node.args]
    case 'Index':
      return [node.object, node.index]
    case 'Member':
      return [node.object]
    case 'Function':
      return [...node.contracts, node.body]
    case 'Contract':
      return [node.expr]
    case 'If':
      return node.else === null ? [node.cond, node.then] : [node.cond, node.then, node.else]
    case 'Match':
      return [node.subject, ...node.arms]
    case 'Arm':
      return node.guard === null ? [node.body] : [node.guard, node.body]
    default:
      return []
  }
}
