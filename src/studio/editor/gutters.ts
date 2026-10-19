/** The breakpoint gutter and the execution heat gutter. */
import { RangeSet, type Extension, type Range } from '@codemirror/state'
import { gutter, GutterMarker, type BlockInfo, type EditorView } from '@codemirror/view'
import { heatLevel, heatTitle, nextHit } from './gutter-math'
import { liveStudio, studioActions, studioOf } from './studio-field'

class BreakpointMarker extends GutterMarker {
  override elementClass = 'ed-bp-on'
  override eq(other: GutterMarker): boolean {
    return other instanceof BreakpointMarker
  }
  override toDOM(): Node {
    const dot = document.createElement('span')
    dot.className = 'ed-bp-dot'
    return dot
  }
}

class SpacerMarker extends GutterMarker {
  override toDOM(): Node {
    const dot = document.createElement('span')
    dot.className = 'ed-bp-spacer'
    return dot
  }
}

class HeatMarker extends GutterMarker {
  constructor(
    readonly count: number,
    readonly level: number,
  ) {
    super()
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof HeatMarker && other.count === this.count && other.level === this.level
  }
  override toDOM(): Node {
    const cell = document.createElement('span')
    // A zero-count marker is only the gutter's width spacer.
    cell.className = this.count > 0 ? 'ed-heat' : 'ed-heat ed-heat-spacer'
    if (this.count > 0) cell.title = heatTitle(this.count)
    const bar = document.createElement('span')
    bar.className = 'ed-heat-bar'
    bar.style.setProperty('--ed-heat', String(this.level))
    cell.append(bar)
    return cell
  }
}

const BREAKPOINT = new BreakpointMarker()

function lineNumber(view: EditorView, block: BlockInfo): number {
  return view.state.doc.lineAt(block.from).number
}

const breakpointGutter = gutter({
  class: 'ed-gutter-bp',
  markers(view) {
    const doc = view.state.doc
    const lines = [...studioOf(view.state).breakpoints].filter((l) => l >= 1 && l <= doc.lines)
    lines.sort((a, b) => a - b)
    return RangeSet.of(lines.map((line) => BREAKPOINT.range(doc.line(line).from)))
  },
  initialSpacer: () => new SpacerMarker(),
  domEventHandlers: {
    mousedown(view, block, event) {
      if ((event as MouseEvent).button !== 0) return false
      view.state.facet(studioActions)?.toggleBreakpoint(lineNumber(view, block))
      return true
    },
  },
})

const heatGutter = gutter({
  class: 'ed-gutter-heat',
  markers(view) {
    const studio = liveStudio(view.state)
    if (!studio) return RangeSet.empty
    const doc = view.state.doc
    const ranges: Range<GutterMarker>[] = []
    for (const [line, count] of studio.hitCounts) {
      if (line < 1 || line > doc.lines || count <= 0) continue
      const marker = new HeatMarker(count, heatLevel(count, studio.maxHits))
      ranges.push(marker.range(doc.line(line).from))
    }
    return RangeSet.of(ranges, true)
  },
  initialSpacer: () => new HeatMarker(0, 1),
  domEventHandlers: {
    mousedown(view, block, event) {
      const studio = liveStudio(view.state)
      if (!studio?.recording || (event as MouseEvent).button !== 0) return false
      const target = nextHit(studio.recording.lineHits(lineNumber(view, block)), studio.time)
      if (target === null) return false
      view.state.facet(studioActions)?.seek(target)
      return true
    },
  },
})

/** Breakpoint dots, left of the line numbers. */
export function breakpointGutterExtension(): Extension {
  return breakpointGutter
}

/** Heat bars, between the line numbers and the code. */
export function heatGutterExtension(): Extension {
  return heatGutter
}
