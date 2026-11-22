/**
 * The response size guard of the MCP server (ARCHITECTURE §9.1). An agent's context window is a
 * budget: a result longer than `MAX_RESPONSE_CHARS` is shortened, never refused. Long lists keep
 * their first items, long texts their beginning, and maps with very many keys (globals, locals)
 * their first keys, halving the allowance until the result fits; the result then says what was
 * cut and how to ask for less. Copies are built with an explicit work stack (no recursion).
 */
import type { Json, JsonObject } from './mcp-shared'

export const MAX_RESPONSE_CHARS = 50_000
/** Objects with at most this many keys are records of a result: their keys are never dropped. */
const STRUCTURAL_KEYS = 32
const MAX_CUT_NOTES = 20
const ELLIPSIS = '…'

interface Allowance {
  readonly items: number
  readonly chars: number
}

/** `body` as is when its JSON text fits in `max` characters, else a shortened copy that does. */
export function guardResponse(body: Json, max: number = MAX_RESPONSE_CHARS): Json {
  if (JSON.stringify(body).length <= max) return body
  let allowance: Allowance = { items: 256, chars: 4000 }
  for (;;) {
    const cuts: string[] = []
    const shrunk = shrink(body, allowance, cuts)
    const result: JsonObject = {
      ...(isObject(shrunk) ? shrunk : { result: shrunk }),
      truncated_by_size_guard: {
        limit_chars: max,
        note:
          'This result was too long, so long lists, texts and maps were shortened (see cut). Ask for ' +
          'less: use the tool’s offset/limit options (output_offset/output_limit, max_depth, ' +
          'max_items, frames, summary: true) to fetch the rest in pages.',
        cut: cuts.slice(0, MAX_CUT_NOTES),
      },
    }
    if (JSON.stringify(result).length <= max) return result
    if (allowance.items === 1 && allowance.chars === 40) return stub(body, max)
    allowance = {
      items: Math.max(1, allowance.items >> 1),
      chars: Math.max(40, allowance.chars >> 1),
    }
  }
}

function isObject(value: Json): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The last resort: only the top-level keys and short texts survive. */
function stub(body: Json, max: number): Json {
  const keys = isObject(body) ? Object.keys(body).slice(0, STRUCTURAL_KEYS) : []
  return {
    truncated_by_size_guard: {
      limit_chars: max,
      note: 'This result was far too long to shorten usefully. Ask for less with the tool’s limit options.',
      keys,
    },
  }
}

interface Task {
  readonly value: Json
  readonly path: string
  readonly assign: (json: Json) => void
}

function shrink(root: Json, allowance: Allowance, cuts: string[]): Json {
  let result: Json = null
  const work: Task[] = [{ value: root, path: '', assign: (json) => (result = json) }]
  while (work.length > 0) {
    const { value, path, assign } = work.pop()!
    if (typeof value === 'string') {
      if (value.length > allowance.chars) {
        cuts.push(`${path || 'text'}: ${value.length} characters, first ${allowance.chars} kept`)
        assign(value.slice(0, allowance.chars - 1) + ELLIPSIS)
      } else assign(value)
      continue
    }
    if (value === null || typeof value !== 'object') {
      assign(value)
      continue
    }
    if (Array.isArray(value)) {
      const kept = value.slice(0, allowance.items)
      if (kept.length < value.length) {
        cuts.push(`${path || 'list'}: ${value.length} items, first ${kept.length} kept`)
      }
      const out: Json[] = kept.map(() => null)
      assign(out)
      // Pushed last to first, so they are visited (and cut notes written) in order.
      for (let i = kept.length - 1; i >= 0; i--) {
        work.push({ value: kept[i]!, path: `${path}[${i}]`, assign: (json) => (out[i] = json) })
      }
      continue
    }
    const keys = Object.keys(value)
    const keptKeys =
      keys.length <= STRUCTURAL_KEYS
        ? keys
        : keys.slice(0, Math.max(STRUCTURAL_KEYS, allowance.items))
    if (keptKeys.length < keys.length) {
      cuts.push(`${path || 'map'}: ${keys.length} keys, first ${keptKeys.length} kept`)
    }
    const out: Record<string, Json> = Object.fromEntries(keptKeys.map((key) => [key, null]))
    assign(out)
    for (const key of [...keptKeys].reverse()) {
      work.push({
        value: value[key]!,
        path: path === '' ? key : `${path}.${key}`,
        assign: (json) =>
          Object.defineProperty(out, key, {
            value: json,
            enumerable: true,
            writable: true,
            configurable: true,
          }),
      })
    }
  }
  return result
}
