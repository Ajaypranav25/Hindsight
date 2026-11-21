/**
 * Writing contract clauses into a program (ARCHITECTURE §7.16): `insertContracts` adds
 * `requires`/`ensures` clauses to `fn` headers, each on a line of its own between the parameter
 * list (or the last existing clause) and the body, which then opens on its own line:
 *
 * ```
 * fn average(xs)
 *   requires len(xs) > 0
 *   ensures result <= max(xs)
 * {
 * ```
 *
 * It also reports where each clause landed, so a failed check can be traced back to its clause.
 */
import type * as ast from './ast'
import { childrenOf, type SyntaxNode } from './oracle-syntax'
import { parse } from './parser'

export interface ClauseText {
  readonly kind: 'requires' | 'ensures'
  /** The clause expression, e.g. `len(xs) > 0`. */
  readonly text: string
}

export interface ContractAddition {
  /** The function: the start of its `fn` (its proto's `debug.span.start`). */
  readonly functionStart: number
  readonly clauses: readonly ClauseText[]
}

export interface PlacedClause {
  readonly functionStart: number
  /** Position in the addition's `clauses`. */
  readonly index: number
  /** The expression's span in the new source. */
  readonly start: number
  readonly end: number
}

export interface InsertedContracts {
  readonly source: string
  readonly placed: readonly PlacedClause[]
  /** Additions whose function was not found (not a `fn` with a block body at that position). */
  readonly missing: readonly number[]
}

/** The `fn` functions of a program (declarations and `fn(…)` expressions), by start offset. */
export function fnFunctions(program: ast.Program): Map<number, ast.FunctionExpr> {
  const found = new Map<number, ast.FunctionExpr>()
  const work: SyntaxNode[] = [...program.body]
  for (let node = work.pop(); node !== undefined; node = work.pop()) {
    if (node.kind === 'Function' && node.form === 'fn' && node.body.kind === 'Block') {
      found.set(node.span.start, node)
    }
    for (const child of childrenOf(node)) work.push(child)
  }
  return found
}

interface Edit {
  readonly functionStart: number
  readonly at: number
  readonly remove: number
  readonly text: string
  /** Offsets of each clause expression within `text`. */
  readonly clauses: readonly {
    readonly index: number
    readonly start: number
    readonly end: number
  }[]
}

/** `source` with the clauses added to the functions' headers (see the module comment). */
export function insertContracts(
  source: string,
  additions: readonly ContractAddition[],
): InsertedContracts {
  const functions = fnFunctions(parse(source).program)
  const edits: Edit[] = []
  const missing: number[] = []
  for (const addition of additions) {
    const fn = functions.get(addition.functionStart)
    if (fn === undefined) missing.push(addition.functionStart)
    else if (addition.clauses.length > 0) edits.push(editFor(source, fn, addition))
  }
  edits.sort((a, b) => a.at - b.at)
  let out = ''
  let copied = 0
  const placed: PlacedClause[] = []
  for (const edit of edits) {
    out += source.slice(copied, edit.at)
    for (const clause of edit.clauses) {
      placed.push({
        functionStart: edit.functionStart,
        index: clause.index,
        start: out.length + clause.start,
        end: out.length + clause.end,
      })
    }
    out += edit.text
    copied = edit.at + edit.remove
  }
  return { source: out + source.slice(copied), placed, missing }
}

function editFor(source: string, fn: ast.FunctionExpr, addition: ContractAddition): Edit {
  const bodyStart = fn.body.span.start
  const last = fn.contracts.at(-1)
  const close = source.lastIndexOf(')', bodyStart - 1)
  const headerEnd = last !== undefined ? last.span.end : Math.max(close + 1, fn.span.start)
  const gap = source.slice(headerEnd, bodyStart)
  const base = indentationAt(source, fn.span.start)
  const first = fn.contracts[0]
  const clauseIndent =
    first !== undefined && startsLine(source, first.keywordSpan.start)
      ? indentationAt(source, first.keywordSpan.start)
      : `${base}  `
  let text = ''
  const clauses: { index: number; start: number; end: number }[] = []
  addition.clauses.forEach((clause, index) => {
    text += `\n${clauseIndent}${clause.kind} `
    clauses.push({ index, start: text.length, end: text.length + clause.text.length })
    text += clause.text
  })
  // A comment between the header and the body stays where it was, after the new clauses.
  if (/^\s*$/.test(gap))
    return {
      functionStart: fn.span.start,
      at: headerEnd,
      remove: gap.length,
      text: `${text}\n${base}`,
      clauses,
    }
  return { functionStart: fn.span.start, at: headerEnd, remove: 0, text, clauses }
}

/** The whitespace that starts the line holding `offset`. */
function indentationAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(source.slice(lineStart))![0]
}

function startsLine(source: string, offset: number): boolean {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*$/.test(source.slice(lineStart, offset))
}
