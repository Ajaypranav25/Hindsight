/**
 * The what-if layer of the heap graph (ARCHITECTURE §7.13, §11.3): what the fork's heap points at
 * that the real run's does not, and the other way round, at the pen's step.
 */
import { useMemo } from 'react'
import type { FrameView, StateView } from '../../core/index'
import { collectRoots, layoutHeap, type HeapLayout } from '../lib/heap-layout'
import { diffLayouts, type HeapLayoutDiff, sameReferences } from '../lib/heap-layout-diff'
import { useStudio } from '../state/context'

/** The most references the accessible description names on each side. */
const MAX_DESCRIBED = 8

/**
 * The difference between the shown what-if state and the real run's state at the same step; null
 * outside a what-if, past the real run's end, or when the references are the same.
 */
export function useHeapDiff(
  view: StateView | null,
  frame: FrameView | null,
  layout: HeapLayout | null,
): HeapLayoutDiff | null {
  const parent = useStudio((s) => s.whatIf?.parent ?? null)
  return useMemo(() => {
    if (parent === null || view === null || layout === null || view.time > parent.length) {
      return null
    }
    const realView = parent.stateAt(view.time)
    // The frame at the same depth: before the runs diverge it is the same call.
    const depth = frame === null ? -1 : view.frames.findIndex((f) => f.uid === frame.uid)
    const realFrame = depth < 0 ? null : (realView.frames[depth] ?? null)
    const real = layoutHeap(
      { roots: collectRoots(realFrame, realView.globals), heap: realView.heap },
      layout.memory,
    )
    const diff = diffLayouts(layout, real)
    return sameReferences(diff) ? null : diff
  }, [parent, view, frame, layout])
}

function listed(texts: readonly string[]): string {
  const shown = texts.slice(0, MAX_DESCRIBED).join('; ')
  const more = texts.length - MAX_DESCRIBED
  return more > 0 ? `${shown}; and ${more} more` : shown
}

/** What the difference is, in words (the colours and dashes say the same to the eye). */
export function heapDiffText(diff: HeapLayoutDiff): string {
  const parts: string[] = []
  if (diff.addedTexts.length > 0) parts.push(`Only in the what-if: ${listed(diff.addedTexts)}.`)
  if (diff.removedTexts.length > 0)
    parts.push(`Only in the real run: ${listed(diff.removedTexts)}.`)
  return parts.join(' ')
}

/** The legend under the toolbar while the what-if's references differ from the real run's. */
export function HeapDiffLegend(props: { readonly diff: HeapLayoutDiff }) {
  const { diff } = props
  return (
    <div className="hp-legend" role="group" aria-label="Compared with the real run">
      <span className="hp-legend-item">
        <svg width="26" height="8" aria-hidden="true">
          <path className="hp-edge is-added" d="M1,4 H25" />
        </svg>
        only in the what-if ({diff.added.size})
      </span>
      <span className="hp-legend-item">
        <svg width="26" height="8" aria-hidden="true">
          <path className="hp-edge is-removed" d="M1,4 H25" />
        </svg>
        only in the real run ({diff.removedTexts.length})
      </span>
      <span className="pn-visually-hidden">{heapDiffText(diff)}</span>
    </div>
  )
}

/** The real run's lost references, dashed, inside the graph's transformed group. */
export function GhostEdges(props: { readonly diff: HeapLayoutDiff; readonly arrowId: string }) {
  return (
    <>
      {props.diff.removed.map((edge) => (
        <path
          key={edge.key}
          className="hp-edge is-removed"
          d={edge.path}
          markerEnd={edge.reaches ? `url(#${props.arrowId})` : undefined}
        />
      ))}
    </>
  )
}
