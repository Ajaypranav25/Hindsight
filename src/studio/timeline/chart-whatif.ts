/**
 * The strip chart's what-if layers (ARCHITECTURE §11.3): the real run's depth as a faint ghost from
 * the fork step on, behind the what-if's own trace, and marks at the fork step and the divergence.
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

export interface ChartWhatIf {
  /** The real run's depth envelope. */
  readonly ghost: DepthEnvelope
  /** The earliest fork step: the futures share everything before it. */
  readonly forkTime: number
  readonly divergence: number | null
}

/** Where the layers go, in device pixels. */
export interface WhatIfLayout {
  readonly view: Viewport
  readonly w: number
  readonly px: number
  readonly top: number
  readonly scale: DepthScale
  readonly color: string
}

const GHOST_ALPHA = 0.5

export function drawGhost(ctx: CanvasRenderingContext2D, whatIf: ChartWhatIf, at: WhatIfLayout) {
  const { view, w, px, scale } = at
  const cols = envelope(whatIf.ghost, view.start, view.end, w)
  const from = Math.max(0, Math.ceil(timeToX(whatIf.forkTime, view, w)))
  const lineWidth = Math.max(1, Math.round(px))
  const alpha = ctx.globalAlpha
  ctx.globalAlpha = alpha * GHOST_ALPHA
  ctx.fillStyle = at.color
  ctx.beginPath()
  for (let c = from; c < w; c++) {
    const max = cols.max[c]!
    if (max === NO_DATA) continue
    const yTop = Math.round(depthToY(max, scale))
    const yBottom = Math.round(depthToY(cols.min[c]!, scale))
    ctx.rect(c, yTop - lineWidth / 2, 1, yBottom - yTop + lineWidth)
  }
  ctx.fill()
  ctx.globalAlpha = alpha
}

/** A dashed rule at the fork step and a solid one, with a diamond, at the divergence. */
export function drawWhatIfMarks(
  ctx: CanvasRenderingContext2D,
  whatIf: ChartWhatIf,
  at: WhatIfLayout,
) {
  const { view, w, px, top, scale } = at
  const width = Math.max(1, Math.round(1.5 * px))
  ctx.fillStyle = at.color
  if (whatIf.forkTime >= view.start && whatIf.forkTime <= view.end) {
    const x = Math.round(timeToX(whatIf.forkTime, view, w))
    for (let y = top; y < scale.baseline; y += 6 * px) {
      ctx.fillRect(x, y, width, Math.min(3 * px, scale.baseline - y))
    }
  }
  const d = whatIf.divergence
  if (d === null || d < view.start || d > view.end) return
  const x = Math.round(timeToX(d, view, w))
  ctx.fillRect(x, top, width, scale.baseline - top)
  const r = 4 * px
  ctx.beginPath()
  ctx.moveTo(x, top - r)
  ctx.lineTo(x + r, top)
  ctx.lineTo(x, top + r)
  ctx.lineTo(x - r, top)
  ctx.closePath()
  ctx.fill()
}
