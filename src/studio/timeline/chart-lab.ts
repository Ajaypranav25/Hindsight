/**
 * The strip chart's query and sweep layers (ARCHITECTURE §11.3): the stretches and moments a
 * query matched, and the depth traces of a sweep's runs as ghosts from the fork step on.
 */
import {
  NO_DATA,
  depthToY,
  envelope,
  timeToX,
  type DepthEnvelope,
  type DepthScale,
  type Viewport,
} from '../lib/timeline-math'

export interface ChartLab {
  /** Stretches a `when` query held in: steps `from..to`. */
  readonly intervals: readonly { readonly from: number; readonly to: number }[]
  /** Moments a `changed` or `calls` query matched, ascending. */
  readonly moments: ArrayLike<number>
  /** The depth envelopes of a sweep's runs. */
  readonly ghosts: readonly DepthEnvelope[]
  /** The sweep's fork step: the runs share everything before it. */
  readonly forkTime: number
}

export interface LabLayout {
  readonly view: Viewport
  readonly w: number
  readonly px: number
  readonly top: number
  readonly scale: DepthScale
}

const BAND_ALPHA = 0.16
const MOMENT_ALPHA = 0.55
const GHOST_ALPHA = 0.3

/** The deepest call depth among the sweep's runs. */
export function labMaxDepth(lab: ChartLab | null | undefined): number {
  let max = 0
  for (const ghost of lab?.ghosts ?? []) if (ghost.maxDepth > max) max = ghost.maxDepth
  return max
}

/** Shaded bands for the stretches and capped hairlines for the moments. */
export function drawQueryMarks(
  ctx: CanvasRenderingContext2D,
  lab: ChartLab,
  at: LabLayout,
  color: string,
): void {
  const { view, w, px, top, scale } = at
  const alpha = ctx.globalAlpha
  ctx.fillStyle = color
  ctx.globalAlpha = alpha * BAND_ALPHA
  for (const { from, to } of lab.intervals) {
    if (to < view.start || from > view.end) continue
    const x0 = Math.max(0, Math.floor(timeToX(from, view, w)))
    const x1 = Math.min(w, Math.ceil(timeToX(to, view, w)))
    ctx.fillRect(x0, top, Math.max(Math.round(px), x1 - x0), scale.baseline - top)
  }
  ctx.globalAlpha = alpha * MOMENT_ALPHA
  const cap = 3 * px
  let lastX = -Infinity
  for (let i = 0; i < lab.moments.length; i++) {
    const t = lab.moments[i]!
    if (t < view.start || t > view.end) continue
    const x = Math.round(timeToX(t, view, w))
    if (x - lastX < 3 * px) continue
    lastX = x
    ctx.fillRect(x, top, Math.max(1, Math.round(px)), scale.baseline - top)
    ctx.beginPath()
    ctx.moveTo(x - cap, top)
    ctx.lineTo(x + cap + px, top)
    ctx.lineTo(x + px / 2, top + cap * 1.5)
    ctx.closePath()
    ctx.fill()
  }
  ctx.globalAlpha = alpha
}

/** Every run of the sweep as a faint trace from the fork step on. */
export function drawSweepGhosts(
  ctx: CanvasRenderingContext2D,
  lab: ChartLab,
  at: LabLayout,
  color: string,
): void {
  const { view, w, px, scale } = at
  const from = Math.max(0, Math.ceil(timeToX(lab.forkTime, view, w)))
  const lineWidth = Math.max(1, Math.round(px))
  const alpha = ctx.globalAlpha
  ctx.globalAlpha = alpha * GHOST_ALPHA
  ctx.fillStyle = color
  for (const ghost of lab.ghosts) {
    const cols = envelope(ghost, view.start, view.end, w)
    ctx.beginPath()
    for (let c = from; c < w; c++) {
      const max = cols.max[c]!
      if (max === NO_DATA) continue
      const yTop = Math.round(depthToY(max, scale))
      const yBottom = Math.round(depthToY(cols.min[c]!, scale))
      ctx.rect(c, yTop - lineWidth / 2, 1, yBottom - yTop + lineWidth)
    }
    ctx.fill()
  }
  ctx.globalAlpha = alpha
}
