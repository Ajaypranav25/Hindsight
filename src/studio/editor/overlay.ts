/** Pure computation of what the editor overlays at the pen (no CodeMirror imports). */
import { LineIndex } from '../../core/index'
import type { FrameView, Recording, Span, StateView, ValueView } from '../../core/index'
import { formatValue, truncate } from '../lib/format'
import { selectedFrame } from '../state/selectors'
import type { OriginMark } from '../state/types'

export const MAX_HINTS = 12
export const HINT_VALUE_CHARS = 32

export interface InlineHint {
  /** 1-based line whose end shows the hint. */
  readonly line: number
  readonly text: string
}

export interface EditorOverlay {
  /** Statement whose lines are tinted. */
  readonly stmtSpan: Span | null
  /** Current instruction, outlined. */
  readonly span: Span | null
  /** Call span of a selected caller frame (shown instead of `span`). */
  readonly callerSpan: Span | null
  /** Name of the library function executing, when the pen is in library code. */
  readonly libraryFunction: string | null
  readonly hints: readonly InlineHint[]
  /** The write an origin jump explains (marked "set here"), while the pen is just after it. */
  readonly originSpan: Span | null
}

export const EMPTY_OVERLAY: EditorOverlay = {
  stmtSpan: null,
  span: null,
  callerSpan: null,
  libraryFunction: null,
  hints: [],
  originSpan: null,
}

export interface OverlayInput {
  readonly view: StateView | null
  readonly stale: boolean
  readonly selectedFrameUid: number | null
  readonly source: string
}

export function clampSpan(span: Span, length: number): Span {
  const start = Math.max(0, Math.min(span.start, length))
  return { start, end: Math.max(start, Math.min(span.end, length)) }
}

/** Overlays for the pen's state; empty while stale or before the first recording. */
export function computeOverlay(input: OverlayInput): EditorOverlay {
  const { view, stale, source } = input
  if (!view || stale) return EMPTY_OVERLAY
  const frame = selectedFrame(view, input.selectedFrameUid)
  const innermost = view.frames[view.frames.length - 1] ?? null
  const hints = inlineHints(view, frame, source)
  const length = source.length
  if (frame && innermost && frame.uid !== innermost.uid) {
    if (frame.source !== 'main') return { ...EMPTY_OVERLAY, hints }
    return {
      ...EMPTY_OVERLAY,
      stmtSpan: clampSpan(frame.stmtSpan, length),
      callerSpan: clampSpan(frame.span, length),
      hints,
    }
  }
  const location = view.location
  if (!location) return { ...EMPTY_OVERLAY, hints }
  if (location.source !== 'main') {
    return { ...EMPTY_OVERLAY, libraryFunction: location.functionName, hints }
  }
  return {
    ...EMPTY_OVERLAY,
    stmtSpan: clampSpan(location.stmtSpan, length),
    span: clampSpan(location.span, length),
    hints,
  }
}

interface Declared {
  readonly name: string
  readonly kind: string
  readonly value: ValueView
  readonly declSpan: Span
}

function hintText(item: Declared): string {
  return `${item.name} = ${truncate(formatValue(item.value), HINT_VALUE_CHARS)}`
}

/**
 * "name = value" at the end of each declaration line of the selected frame's live locals (plus
 * the user globals when the selected frame is the top level), at most MAX_HINTS lines.
 */
export function inlineHints(
  view: StateView,
  frame: FrameView | null,
  source: string,
): InlineHint[] {
  if (!frame || frame.source !== 'main') return []
  const declared: Declared[] = frame.locals.filter((local) => local.kind !== 'hidden')
  if (frame.uid === view.frames[0]?.uid) declared.push(...view.globals)
  const lines = new LineIndex(source)
  const byLine = new Map<number, string[]>()
  for (const item of declared) {
    if (item.kind === 'fn' || item.declSpan.start < 0 || item.declSpan.start >= source.length)
      continue
    const line = lines.lineOf(item.declSpan.start)
    const texts = byLine.get(line)
    if (texts) texts.push(hintText(item))
    else if (byLine.size < MAX_HINTS) byLine.set(line, [hintText(item)])
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, texts]) => ({ line, text: texts.join(', ') }))
}

/**
 * The span of the write an origin jump explains: shown while the pen sits on the step right after
 * it, and only when that write happened in the main source.
 */
export function originSpanAt(
  recording: Recording | null,
  mark: OriginMark | null,
  time: number,
  length: number,
): Span | null {
  if (!recording || !mark || time !== mark.time + 1) return null
  const location = recording.locationAt(mark.time)
  if (!location || location.source !== 'main') return null
  const span = clampSpan(location.span, length)
  return span.end > span.start ? span : null
}
