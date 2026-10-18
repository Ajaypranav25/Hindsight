/**
 * A compact S-expression rendering of the AST, used by tests and the CLI. It walks the tree with an
 * explicit work stack, so arbitrarily deep trees never recurse on the JavaScript stack.
 *
 * Expressions print as `(op operand…)` (`(call f a)`, `(pipe f x)` for calls written with `|>`,
 * `(. obj name)`, `(index obj i)`); literals as source-like atoms; statements as `(let p e)`,
 * `(= target value)`, `(fn name (params) body)`; patterns as `x`, `_`, `1..=5`, `[a ...rest]`,
 * `{a key:p}` and `(| p q)`.
 */
import type {
  Block,
  Expr,
  FunctionExpr,
  MatchArm,
  Pattern,
  Program,
  RecordField,
  RestPattern,
  Spread,
  Stmt,
} from './ast'
import { isKeyword } from './tokens'

export type AstNode =
  Program | Stmt | Block | Expr | Spread | RecordField | MatchArm | Pattern | RestPattern

type Part = string | AstNode

export function printAst(node: AstNode): string {
  const out: string[] = []
  const work: Part[] = [node]
  for (let part = work.pop(); part !== undefined; part = work.pop()) {
    if (typeof part === 'string') {
      out.push(part)
      continue
    }
    const parts = expand(part)
    for (let i = parts.length - 1; i >= 0; i--) work.push(parts[i]!)
  }
  return out.join('')
}

/** `(head item item …)`. */
function group(head: string, items: readonly Part[]): Part[] {
  return sequence(`(${head}`, items, ')', ' ')
}

/** `open item item … close`, with `lead` before the first item. */
function sequence(open: string, items: readonly Part[], close: string, lead = ''): Part[] {
  const parts: Part[] = [open]
  items.forEach((item, i) => parts.push(i === 0 ? lead : ' ', item))
  parts.push(close)
  return parts
}

function formatNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value)
}

function formatLiteral(value: number | string | boolean | null): string {
  if (value === null) return 'nil'
  if (typeof value === 'number') return formatNumber(value)
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/** Record keys print bare when they read as identifiers, quoted otherwise. */
function formatKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !isKeyword(key) ? key : JSON.stringify(key)
}

function functionParts(fn: FunctionExpr): Part[] {
  const head = fn.form === 'lambda' ? '(lambda ' : fn.name === null ? '(fn ' : `(fn ${fn.name} `
  return [...sequence(head + '(', fn.params, ') '), fn.body, ')']
}

function templateParts(quasis: readonly string[], exprs: readonly Expr[]): Part[] {
  const items: Part[] = []
  quasis.forEach((quasi, i) => {
    items.push(JSON.stringify(quasi))
    const expr = exprs[i]
    if (expr !== undefined) items.push(expr)
  })
  return group('template', items)
}

function armParts(arm: MatchArm): Part[] {
  const guard: Part[] = arm.guard === null ? [] : [' (if ', arm.guard, ')']
  return ['(arm ', arm.pattern, ...guard, ' ', arm.body, ')']
}

function recordPatternParts(pattern: Extract<Pattern, { kind: 'PRecord' }>): Part[] {
  const parts: Part[] = ['{']
  pattern.fields.forEach((field, i) => {
    if (i > 0) parts.push(' ')
    if (!field.shorthand) parts.push(`${formatKey(field.key)}:`)
    parts.push(field.pattern)
  })
  parts.push('}')
  return parts
}

function expand(node: AstNode): Part[] {
  switch (node.kind) {
    case 'Program':
      return group('program', node.body)
    case 'ExprStmt':
      return [node.expr]
    case 'Let':
      return group(node.mutable ? 'var' : 'let', [node.pattern, node.init])
    case 'FnDecl':
      return functionParts(node.fn)
    case 'Assign':
      return group(node.op, [node.target, node.value])
    case 'Return':
      return group('return', node.value === null ? [] : [node.value])
    case 'Break':
      return ['(break)']
    case 'Continue':
      return ['(continue)']
    case 'While':
      return group('while', [node.cond, node.body])
    case 'For':
      return group('for', [node.pattern, node.iterable, node.body])
    case 'BlockStmt':
      return [node.block]
    case 'Block':
      return group('block', node.body)
    default:
      return expandExpression(node)
  }
}

function expandExpression(node: Exclude<AstNode, Program | Stmt | Block>): Part[] {
  switch (node.kind) {
    case 'Number':
      return [formatNumber(node.value)]
    case 'String':
      return [JSON.stringify(node.value)]
    case 'Template':
      return templateParts(node.quasis, node.exprs)
    case 'Bool':
      return [String(node.value)]
    case 'Nil':
      return ['nil']
    case 'Ident':
      return [node.name]
    case 'List':
      return group('list', node.items)
    case 'Spread':
      return group('...', [node.expr])
    case 'Record':
      return group('record', node.items)
    case 'Field':
      return node.shorthand ? [formatKey(node.key)] : [`${formatKey(node.key)}:`, node.value]
    case 'Unary':
      return group(node.op, [node.operand])
    case 'Binary':
    case 'Logical':
      return group(node.op, [node.left, node.right])
    case 'Call':
      return group(node.pipe ? 'pipe' : 'call', [node.callee, ...node.args])
    case 'Index':
      return group('index', [node.object, node.index])
    case 'Member':
      return group('.', [node.object, node.name])
    case 'Function':
      return functionParts(node)
    case 'If':
      return group('if', node.else === null ? [node.cond, node.then] : [node.cond, node.then, node.else])
    case 'Match':
      return group('match', [node.subject, ...node.arms])
    case 'Arm':
      return armParts(node)
    default:
      return expandPattern(node)
  }
}

function expandPattern(node: Pattern | RestPattern): Part[] {
  switch (node.kind) {
    case 'PWildcard':
      return ['_']
    case 'PBind':
      return [node.name]
    case 'PLiteral':
      return [formatLiteral(node.value)]
    case 'PRange':
      return [`${formatNumber(node.start)}${node.inclusive ? '..=' : '..'}${formatNumber(node.end)}`]
    case 'PRest':
      return [node.name === null ? '...' : `...${node.name}`]
    case 'PList':
      return sequence('[', [...node.before, ...(node.rest === null ? [] : [node.rest]), ...node.after], ']')
    case 'PRecord':
      return recordPatternParts(node)
    case 'POr':
      return group('|', node.alternatives)
  }
}
