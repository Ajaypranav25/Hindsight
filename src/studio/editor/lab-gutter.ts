/**
 * The lab gutter, between the heat bars and the code (ARCHITECTURE §11.3): a causal bar on every
 * line of a backward slice, an arrowhead on the line where the traced step itself ran (the
 * effect), and a badge on the guard that kept an explained line from running.
 */
import { RangeSet, type Extension, type Range } from '@codemirror/state'
import { gutter, GutterMarker } from '@codemirror/view'
import { liveStudio } from './studio-field'

type LabMark = 'cause' | 'effect' | 'guard'

const TITLES: Readonly<Record<LabMark, string>> = {
  cause: 'Led to the traced step',
  effect: 'The traced step ran here',
  guard: 'This decided that the explained line did not run',
}

class LabMarker extends GutterMarker {
  constructor(readonly mark: LabMark) {
    super()
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof LabMarker && other.mark === this.mark
  }
  override toDOM(): Node {
    const cell = document.createElement('span')
    cell.className = `ed-lab-mark ed-lab-${this.mark}`
    cell.title = TITLES[this.mark]
    return cell
  }
}

class SpacerMarker extends GutterMarker {
  override toDOM(): Node {
    const cell = document.createElement('span')
    cell.className = 'ed-lab-mark'
    return cell
  }
}

const MARKERS: Readonly<Record<LabMark, LabMarker>> = {
  cause: new LabMarker('cause'),
  effect: new LabMarker('effect'),
  guard: new LabMarker('guard'),
}

/** The mark of each line: a guard badge wins over the effect, the effect over a cause. */
export function labMarks(
  lines: number,
  slice: ReadonlySet<number> | null,
  effectLine: number | null,
  guardLine: number | null,
): Map<number, LabMark> {
  const marks = new Map<number, LabMark>()
  for (const line of slice ?? []) if (line >= 1 && line <= lines) marks.set(line, 'cause')
  if (slice !== null && effectLine !== null && effectLine >= 1 && effectLine <= lines) {
    marks.set(effectLine, 'effect')
  }
  if (guardLine !== null && guardLine >= 1 && guardLine <= lines) marks.set(guardLine, 'guard')
  return marks
}

const labGutter = gutter({
  class: 'ed-gutter-lab',
  markers(view) {
    const studio = liveStudio(view.state)
    if (!studio) return RangeSet.empty
    const { overlay } = studio
    const doc = view.state.doc
    const marks = labMarks(
      doc.lines,
      overlay.keepLines ?? null,
      overlay.effectLine ?? null,
      overlay.guardLine ?? null,
    )
    const ranges: Range<GutterMarker>[] = []
    for (const [line, mark] of [...marks].sort((a, b) => a[0] - b[0])) {
      ranges.push(MARKERS[mark].range(doc.line(line).from))
    }
    return RangeSet.of(ranges)
  },
  initialSpacer: () => new SpacerMarker(),
})

export function labGutterExtension(): Extension {
  return labGutter
}
