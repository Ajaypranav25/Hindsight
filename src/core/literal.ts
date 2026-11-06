/**
 * Literal values for what-if edits (ARCHITECTURE §7.5). `parseLiteralValue` reads what a user types
 * (a Hindsight number, string, `true`, `false` or `nil`, through the lexer); `formatLiteral` writes
 * a value so that it reads back unchanged. (`repr` is not enough: it leaves `{` and `}` unescaped,
 * and the lexer reads those as string interpolation.)
 */
import type { EditValue, LiteralResult } from './api-types'
import { lex } from './lexer'
import type { Token } from './tokens'

const EXPECTED = 'Type a number, a string in double quotes, true, false or nil'

export function parseLiteralValue(text: string): LiteralResult {
  const { tokens, diagnostics } = lex(text)
  const first = diagnostics[0]
  if (first !== undefined) return { ok: false, error: first.message }
  const body = tokens.filter((token) => token.kind !== 'EOF')
  const value = literalOf(body)
  if (value !== undefined) return { ok: true, value }
  const name = body.length === 1 && body[0]!.kind === 'Identifier' ? body[0]!.value : null
  if (name !== null) {
    return { ok: false, error: `${String(name)} is a name, not a value: put text in double quotes` }
  }
  return { ok: false, error: EXPECTED }
}

/** The value of a lone literal token (or of `-` and a number); undefined for anything else. */
function literalOf(tokens: readonly Token[]): EditValue | undefined {
  const [first, second] = tokens
  if (tokens.length === 2 && first!.kind === '-' && second!.kind === 'Number') {
    return -(second!.value as number)
  }
  if (tokens.length !== 1) return undefined
  switch (first!.kind) {
    case 'Number':
      return first!.value as number
    case 'String':
      return first!.value as string
    case 'true':
      return true
    case 'false':
      return false
    case 'nil':
      return null
    default:
      return undefined
  }
}

/** The literal text of `value` (numbers as JavaScript writes them; NaN and ±Infinity have none). */
export function formatLiteral(value: EditValue): string {
  if (value === null) return 'nil'
  if (typeof value !== 'string') return String(value)
  let out = '"'
  for (let i = 0; i < value.length; i++) out += escapeUnit(value, i)
  return `${out}"`
}

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\\', '\\\\'],
  ['"', '\\"'],
  ['\n', '\\n'],
  ['\t', '\\t'],
  ['\r', '\\r'],
  ['\0', '\\0'],
  ['{', '\\{'],
  ['}', '\\}'],
])

function escapeUnit(text: string, i: number): string {
  const unit = text[i]!
  const escaped = ESCAPES.get(unit)
  if (escaped !== undefined) return escaped
  const code = text.charCodeAt(i)
  return code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : unit
}
