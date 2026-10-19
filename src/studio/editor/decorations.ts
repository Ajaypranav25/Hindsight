/** Pen decorations: current statement, current span, caller span and inline value hints. */
import type { EditorState, Range, Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { Span } from '../../core/index'
import type { EditorOverlay } from './overlay'
import { liveStudio, studioField } from './studio-field'

class HintWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  override eq(other: HintWidget): boolean {
    return other.text === this.text
  }
  toDOM(): HTMLElement {
    const hint = document.createElement('span')
    hint.className = 'ed-hint'
    hint.textContent = this.text
    hint.setAttribute('aria-hidden', 'true')
    return hint
  }
  override ignoreEvent(): boolean {
    return false
  }
}

class OriginLabelWidget extends WidgetType {
  override eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const label = document.createElement('span')
    label.className = 'ed-origin-label'
    label.textContent = 'set here'
    label.setAttribute('aria-hidden', 'true')
    return label
  }
}

const LINE_CURRENT = Decoration.line({ class: 'ed-line-current' })
const LINE_CALLER = Decoration.line({ class: 'ed-line-caller' })
const SPAN_CURRENT = Decoration.mark({ class: 'ed-span-current' })
const SPAN_CALLER = Decoration.mark({ class: 'ed-span-caller' })
const SPAN_ORIGIN = Decoration.mark({ class: 'ed-span-origin' })
const ORIGIN_LABEL = Decoration.widget({ widget: new OriginLabelWidget(), side: 1 })

/** 1-based line of the last character of `span` (its start line when empty). */
function lastLineOf(doc: Text, span: Span): number {
  return doc.lineAt(Math.min(Math.max(span.start, span.end - 1), doc.length)).number
}

/**
 * The lines tinted for a statement: from the statement's first line through the line where the
 * current instruction ends, never past the statement's last line. A loop header or an `if`
 * condition therefore tints only its own line, not the whole block. Without an instruction span
 * the whole statement is tinted.
 */
export function tintLineRange(
  doc: Text,
  stmtSpan: Span,
  span: Span | null,
): { readonly first: number; readonly last: number } {
  const first = doc.lineAt(Math.min(stmtSpan.start, doc.length)).number
  const stmtLast = lastLineOf(doc, stmtSpan)
  if (!span) return { first, last: stmtLast }
  return { first, last: Math.max(first, Math.min(stmtLast, lastLineOf(doc, span))) }
}

function lineDecorations(
  state: EditorState,
  stmtSpan: Span,
  span: Span | null,
  deco: Decoration,
): Range<Decoration>[] {
  const doc = state.doc
  const { first, last } = tintLineRange(doc, stmtSpan, span)
  const ranges: Range<Decoration>[] = []
  for (let line = first; line <= last; line++) ranges.push(deco.range(doc.line(line).from))
  return ranges
}

/** The decorations for an overlay on a document (positions already clamped to it). */
export function overlayDecorations(state: EditorState, overlay: EditorOverlay): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const caller = overlay.callerSpan !== null
  const span = overlay.callerSpan ?? overlay.span
  if (overlay.stmtSpan)
    ranges.push(
      ...lineDecorations(state, overlay.stmtSpan, span, caller ? LINE_CALLER : LINE_CURRENT),
    )
  if (span && span.end > span.start && span.end <= state.doc.length)
    ranges.push((caller ? SPAN_CALLER : SPAN_CURRENT).range(span.start, span.end))
  const origin = overlay.originSpan
  if (origin && origin.end > origin.start && origin.end <= state.doc.length) {
    ranges.push(SPAN_ORIGIN.range(origin.start, origin.end))
    ranges.push(ORIGIN_LABEL.range(origin.end))
  }
  for (const hint of overlay.hints) {
    if (hint.line > state.doc.lines) continue
    const widget = Decoration.widget({ widget: new HintWidget(hint.text), side: 1 })
    ranges.push(widget.range(state.doc.line(hint.line).to))
  }
  return Decoration.set(ranges, true)
}

/** Pen decorations, hidden while the recording is stale or the document has unsynced edits. */
export const penDecorations = EditorView.decorations.compute([studioField], (state) => {
  const studio = liveStudio(state)
  return studio ? overlayDecorations(state, studio.overlay) : Decoration.none
})

/** Margin (px) kept between the statement and the edge of the editor when scrolling to it. */
const SCROLL_MARGIN = 24

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : true
}

/** Scrolls the statement starting at `pos` into view (smoothly unless motion is reduced). */
export function scrollStatementIntoView(view: EditorView, pos: number): void {
  const scroller = view.scrollDOM
  const block = view.lineBlockAt(Math.min(pos, view.state.doc.length))
  const docTop = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop
  const top = docTop + block.top
  const bottom = docTop + block.bottom
  const viewTop = scroller.scrollTop
  const viewBottom = viewTop + scroller.clientHeight
  if (top >= viewTop + SCROLL_MARGIN && bottom <= viewBottom - SCROLL_MARGIN) return
  const target = Math.max(0, top - scroller.clientHeight / 3)
  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top: target, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  } else {
    scroller.scrollTop = target
  }
}
