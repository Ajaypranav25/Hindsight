/**
 * Example queries for the query bar (ARCHITECTURE §7.9, §11.3), one per query form, written with
 * names from the program on display so that choosing one shows something at once:
 * `when depth > 2`, `changed(order.paid)`, `calls(fib) where ret > 20`.
 */
import { lex, type Token } from '../../core/index'

export interface QueryExample {
  readonly text: string
  /** What the form finds. */
  readonly detail: string
}

const WHEN_DETAIL = 'Stretches of the run while a condition held'
const CHANGED_DETAIL = 'Every write to a variable, field or list element'
const CALLS_DETAIL = 'Calls of a function, filtered by arguments and result (ret)'
const ASSIGNMENTS: ReadonlySet<string> = new Set(['=', '+=', '-=', '*=', '/=', '%='])

/** The names the examples are written with. */
interface ProgramNames {
  /** The first function declared by name. */
  readonly fn: string | null
  /** The first field written (`order.paid = true`). */
  readonly field: string | null
  /** The first variable written again after its declaration, else the first declared. */
  readonly variable: string | null
}

const name = (token: Token | undefined): string | null =>
  token?.kind === 'Identifier' && typeof token.value === 'string' ? token.value : null

/** Reads the names off the program's tokens (comments and strings cannot fool it). */
export function programNames(source: string): ProgramNames {
  const { tokens } = lex(source)
  let fn: string | null = null
  let field: string | null = null
  let declared: string | null = null
  let reassigned: string | null = null
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const next = name(tokens[i + 1])
    if (token.kind === 'fn' && next !== null) fn ??= next
    else if ((token.kind === 'var' || token.kind === 'let') && next !== null) declared ??= next
    const here = name(token)
    if (here === null || tokens[i - 1]?.kind === '.') continue
    const after = tokens[i + 1]?.kind
    const declaration = tokens[i - 1]?.kind === 'var' || tokens[i - 1]?.kind === 'let'
    if (after !== undefined && ASSIGNMENTS.has(after) && !declaration) reassigned ??= here
    const member = name(tokens[i + 2])
    const assigned = tokens[i + 3]?.kind
    if (after === '.' && member !== null && assigned !== undefined && ASSIGNMENTS.has(assigned)) {
      field ??= `${here}.${member}`
    }
  }
  return { fn, field, variable: reassigned ?? declared }
}

/** One example per form that the program has names for (`when` always). */
export function queryExamples(source: string): QueryExample[] {
  const { fn, field, variable } = programNames(source)
  let when = 'when step > 10'
  if (fn !== null) when = 'when depth > 2'
  else if (variable !== null) when = `when ${variable} > 10`
  const examples: QueryExample[] = [{ text: when, detail: WHEN_DETAIL }]
  const changed = field ?? variable
  if (changed !== null) examples.push({ text: `changed(${changed})`, detail: CHANGED_DETAIL })
  if (fn !== null) examples.push({ text: `calls(${fn}) where ret > 20`, detail: CALLS_DETAIL })
  return examples
}

/** The field's placeholder: the examples side by side. */
export function queryPlaceholder(examples: readonly QueryExample[]): string {
  return examples.map((example) => example.text).join(' · ')
}
