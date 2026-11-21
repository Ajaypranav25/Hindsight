/**
 * Program inputs for differential runs (ARCHITECTURE §7.14). A Hindsight program reads no input,
 * so an "input" is a top-level `let`/`var` binding: `withInput` rewrites the program text so that
 * the binding's initializer is replaced by a literal (`let scores = [92, 88, 95]` with
 * `scores=[70, 80]` becomes `let scores = [70, 80]`). The result is an ordinary program, recorded
 * and compared like any other version of the file; replacing the text (instead of forking the run
 * after the declaration) lets an input be a list or a record, not just a primitive. The whole
 * initializer is replaced, so calls it made are not made with the new input.
 */
import type * as ast from './ast'
import { parse } from './parser'
import { LineIndex } from './span'

export type InputResult =
  | {
      readonly ok: true
      /** The program with the binding's initializer replaced. */
      readonly source: string
      /** 1-based line of the declaration. */
      readonly line: number
      /** The initializer's text in the original program. */
      readonly was: string
      /** The literal that replaced it, as given (trimmed). */
      readonly now: string
    }
  | { readonly ok: false; readonly error: string }

const LITERAL_HELP =
  'Give a literal: a number, a string in double quotes, true, false, nil, or a list or record of literals'

/** `source` with the top-level binding `name` initialized to the literal `valueText` instead. */
export function withInput(source: string, name: string, valueText: string): InputResult {
  const parsed = parse(source)
  const problem = parsed.diagnostics[0]
  if (problem !== undefined)
    return { ok: false, error: `The program does not parse: ${problem.message}` }
  const declaration = topLevelBinding(parsed.program, name)
  if (declaration === null) {
    const names = topLevelNames(parsed.program)
    const known = names.length === 0 ? 'it has none' : `it has ${names.join(', ')}`
    return {
      ok: false,
      error: `The program has no top-level let or var named ${name} (${known})`,
    }
  }
  const now = valueText.trim()
  const literal = literalProblem(now)
  if (literal !== null) return { ok: false, error: `${name}=${now}: ${literal}` }
  const { span } = declaration.init
  return {
    ok: true,
    source: source.slice(0, span.start) + now + source.slice(span.end),
    line: new LineIndex(source).lineOf(declaration.span.start),
    was: source.slice(span.start, span.end),
    now,
  }
}

function topLevelBinding(program: ast.Program, name: string): ast.LetStmt | null {
  for (const statement of program.body) {
    if (statement.kind !== 'Let') continue
    if (statement.pattern.kind === 'PBind' && statement.pattern.name === name) return statement
  }
  return null
}

function topLevelNames(program: ast.Program): string[] {
  return program.body.flatMap((statement) =>
    statement.kind === 'Let' && statement.pattern.kind === 'PBind' ? [statement.pattern.name] : [],
  )
}

/** Why `text` is not a single literal expression, or null when it is one. */
function literalProblem(text: string): string | null {
  if (text === '') return LITERAL_HELP
  // In parentheses, so a record literal is not read as a block.
  const parsed = parse(`(${text})`)
  const problem = parsed.diagnostics[0]
  if (problem !== undefined) return `${problem.message}. ${LITERAL_HELP}`
  const [statement, extra] = parsed.program.body
  if (statement === undefined || extra !== undefined || statement.kind !== 'ExprStmt') {
    return LITERAL_HELP
  }
  return isLiteral(statement.expr) ? null : LITERAL_HELP
}

/** True for literals and lists or records of literals (an explicit work stack, no recursion). */
function isLiteral(root: ast.Expr): boolean {
  const work: ast.Expr[] = [root]
  while (work.length > 0) {
    const node = work.pop()!
    switch (node.kind) {
      case 'Number':
      case 'String':
      case 'Bool':
      case 'Nil':
        break
      case 'Unary':
        if (node.op !== '-' || node.operand.kind !== 'Number') return false
        break
      case 'List':
        for (const item of node.items) {
          if (item.kind === 'Spread') return false
          work.push(item)
        }
        break
      case 'Record':
        for (const item of node.items) {
          if (item.kind === 'Spread' || item.shorthand) return false
          work.push(item.value)
        }
        break
      default:
        return false
    }
  }
  return true
}
