/** Pen decorations: current statement, current span, caller span and inline value hints. */
import type { EditorState, Range } from '@codemirror/state'
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

const LINE_CURRENT = Decoration.line({ class: 'ed-line-current' })
const LINE_CALLER = Decoration.line({ class: 'ed-line-caller' })
const SPAN_CURRENT = Decoration.mark({ class: 'ed-span-current' })
const SPAN_CALLER = Decoration.mark({ class: 'ed-span-caller' })

function lineDecorations(state: EditorState, span: Span, deco: Decoration): Range<Decoration>[] {
  const doc = state.doc
  const first = doc.lineAt(Math.min(span.start, doc.length)).number
  const last = doc.lineAt(Math.min(Math.max(span.start, span.end - 1), doc.length)).number
  const ranges: Range<Decoration>[] = []
  for (let line = first; line <= last; line++) ranges.push(deco.range(doc.line(line).from))
  return ranges
}

/** The decorations for an overlay on a document (positions already clamped to it). */
export function overlayDecorations(state: EditorState, overlay: EditorOverlay): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const caller = overlay.callerSpan !== null
  if (overlay.stmtSpan)
    ranges.push(...lineDecorations(state, overlay.stmtSpan, caller ? LINE_CALLER : LINE_CURRENT))
  const span = overlay.callerSpan ?? overlay.span
  if (span && span.end > span.start && span.end <= state.doc.length)
    ranges.push((caller ? SPAN_CALLER : SPAN_CURRENT).range(span.start, span.end))
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
