/**
 * What a model is shown about a call (ARCHITECTURE §9.2): the function's source with the comment
 * lines just above it, the source of the user functions the call itself called (bounded), and the
 * argument values as Hindsight text. Read through the public Recording and CallTree APIs only.
 */
import {
  type CallDetails,
  type CallNode,
  type CallTree,
  LineIndex,
  type Recording,
  type Span,
  type ValueView,
} from '../../core/index'
import { deepText } from '../../core/call-values'

/** The most helper functions shown beside a function. */
export const MAX_HELPERS = 6
/** The most characters of helper source shown in all. */
export const MAX_HELPER_TEXT = 6_000
/** The most characters of one function's source shown. */
export const MAX_FUNCTION_TEXT = 8_000
/** The most characters of one argument's text. */
export const MAX_VALUE_TEXT = 2_000
/** Comment lines above a function taken as its documentation. */
const MAX_DOC_LINES = 12

/** The source of a function of the program: its declaration and its doc comment; null if none. */
export function functionSource(recording: Recording, protoId: number): string | null {
  const { program } = recording
  const proto = program.protos[protoId - program.firstProtoId]
  if (proto === undefined || proto.debug.source !== 'main' || proto.kind !== 'function') return null
  const { source } = program
  const index = new LineIndex(source)
  const first = index.lineOf(proto.debug.span.start)
  let start = first
  while (start > 1 && first - start < MAX_DOC_LINES && isComment(index.lineText(start - 1))) {
    start -= 1
  }
  const from = start < first ? index.lineStart(start) : proto.debug.span.start
  const text = source.slice(from, proto.debug.span.end)
  return text.length > MAX_FUNCTION_TEXT ? `${text.slice(0, MAX_FUNCTION_TEXT)}\n// … cut` : text
}

function isComment(line: string): boolean {
  const text = line.trim()
  return text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')
}

/** The span of a function of the program, or null. */
function spanOf(recording: Recording, protoId: number): Span | null {
  const { program } = recording
  return program.protos[protoId - program.firstProtoId]?.debug.span ?? null
}

/**
 * The user functions `call` called itself, bounded in number and size: not itself again, and not
 * the functions written inside it (its source already shows them).
 */
export function helperSources(tree: CallTree, call: CallNode): string[] {
  const seen = new Set<number>([call.protoId])
  const outer = spanOf(tree.recording, call.protoId)
  const inside = (protoId: number): boolean => {
    const span = spanOf(tree.recording, protoId)
    return outer !== null && span !== null && span.start >= outer.start && span.end <= outer.end
  }
  const helpers: string[] = []
  let length = 0
  for (const child of tree.children(call, { justMyCode: true })) {
    if (helpers.length >= MAX_HELPERS) break
    if (child.library || seen.has(child.protoId) || inside(child.protoId)) continue
    seen.add(child.protoId)
    const text = functionSource(tree.recording, child.protoId)
    if (text === null || length + text.length > MAX_HELPER_TEXT) continue
    helpers.push(text)
    length += text.length
  }
  return helpers
}

/** A value at `time` as Hindsight text (lists and records in full, up to a limit). */
export function valueText(recording: Recording, time: number, value: ValueView): string {
  return deepText(recording, time, value, 'display', MAX_VALUE_TEXT)?.text ?? '?'
}

/** The call as `name(param = value, …)`, with full argument values. */
export function callWithArguments(recording: Recording, details: CallDetails): string {
  const args = details.args.map(
    (arg) => `${arg.name} = ${valueText(recording, details.call.entry, arg.value)}`,
  )
  return `${details.call.name}(${args.join(', ')})`
}

/** What the call returned, as Hindsight text; null when it did not return. */
export function resultText(recording: Recording, details: CallDetails): string | null {
  if (details.call.outcome !== 'returned' || details.result === null) return null
  return valueText(recording, details.call.exit + 1, details.result.value)
}
