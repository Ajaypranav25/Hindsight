/**
 * Swim lanes on the strip chart (ARCHITECTURE §11.3): for a run with tasks the plot is split into
 * one band per task, each with its label, its own depth trace in its own color and its waiting
 * stretches hatched. Drawn in device pixels from the per-column lane envelopes, so long runs draw
 * as fast as the single trace.
 */
import { laneEnvelope, type LaneModel } from '../lib/lanes'
import {
  NO_DATA,
  depthScale,
  depthToY,
  timeToX,
  type DepthScale,
  type Viewport,
} from '../lib/timeline-math'

/** What the chart shows of a run with tasks. */
export interface ChartLanes {
  readonly model: LaneModel
  /** The task at the pen (its lane holds the pen's dot). */
  readonly penTask: number
}

export interface LaneLayout {
  readonly view: Viewport
  /** Device pixels. */
  readonly w: number
  readonly px: number
  readonly top: number
  readonly baseline: number
  readonly maxUnit: number
  /** Lane colors, cycled. */
  readonly colors: readonly string[]
  readonly waitColor: string
  readonly ruleColor: string
  readonly font: string
}

/** The vertical band and depth scale of each lane, top to bottom. */
export function laneBands(
  model: LaneModel,
  layout: LaneLayout,
): { readonly top: number; readonly bottom: number; readonly scale: DepthScale }[] {
  const count = Math.max(1, model.lanes.length)
  const height = (layout.baseline - layout.top) / count
  return model.lanes.map((lane, index) => {
    const top = layout.top + index * height
    const bottom = top + height
    const scale = depthScale(
      lane.maxDepth,
      top + 12 * layout.px,
      bottom - layout.px,
      layout.maxUnit,
    )
    return { top, bottom, scale }
  })
}

export function drawLanes(ctx: CanvasRenderingContext2D, lanes: ChartLanes, layout: LaneLayout) {
  const { model } = lanes
  const bands = laneBands(model, layout)
  model.lanes.forEach((lane, index) => {
    const band = bands[index]!
    const color = layout.colors[index % layout.colors.length]!
    if (index > 0) {
      ctx.fillStyle = layout.ruleColor
      ctx.fillRect(0, Math.round(band.top), layout.w, Math.max(1, Math.round(layout.px)))
    }
    drawWaits(ctx, lane.waits, band, layout)
    drawLaneTrace(ctx, model, index, band.scale, color, layout)
    ctx.font = `${10 * layout.px}px ${layout.font || 'monospace'}`
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.fillStyle = color
    ctx.fillText(lane.label, 3 * layout.px, band.top + 2 * layout.px)
  })
}

function drawLaneTrace(
  ctx: CanvasRenderingContext2D,
  model: LaneModel,
  lane: number,
  scale: DepthScale,
  color: string,
  layout: LaneLayout,
): void {
  const { w, px, view } = layout
  const cols = laneEnvelope(model, lane, view.start, view.end, w)
  ctx.fillStyle = color
  ctx.globalAlpha = 0.14
  ctx.beginPath()
  for (let c = 0; c < w; c++) {
    if (cols.max[c] === NO_DATA) continue
    const y = depthToY(cols.max[c]!, scale)
    ctx.rect(c, y, 1, scale.baseline - y)
  }
  ctx.fill()
  ctx.globalAlpha = 1
  const lineWidth = Math.max(1, Math.round(px * 1.25))
  ctx.beginPath()
  for (let c = 0; c < w; c++) {
    const max = cols.max[c]!
    if (max === NO_DATA) continue
    const yTop = Math.round(depthToY(max, scale))
    const yBottom = Math.round(depthToY(cols.min[c]!, scale))
    ctx.rect(c, yTop - lineWidth / 2, 1, yBottom - yTop + lineWidth)
  }
  ctx.fill()
}

/** Hatches each waiting stretch in the band, merging stretches that share pixels. */
function drawWaits(
  ctx: CanvasRenderingContext2D,
  waits: Float64Array,
  band: { readonly top: number; readonly bottom: number },
  layout: LaneLayout,
): void {
  const { view, w, px } = layout
  let pending: [number, number] | null = null
  const flush = () => {
    if (pending === null) return
    hatch(
      ctx,
      pending[0],
      band.top,
      Math.max(px, pending[1] - pending[0]),
      band.bottom - band.top,
      layout,
    )
    pending = null
  }
  for (let i = 0; i < waits.length; i += 2) {
    const start = waits[i]!
    const end = waits[i + 1]!
    if (end < view.start || start > view.end) continue
    const x0 = Math.max(0, timeToX(start, view, w))
    const x1 = Math.min(w, timeToX(end, view, w))
    if (pending !== null && x0 <= pending[1] + px) pending[1] = Math.max(pending[1], x1)
    else {
      flush()
      pending = [x0, x1]
    }
  }
  flush()
}

function hatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  layout: LaneLayout,
): void {
  const pitch = 6 * layout.px
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, width, height)
  ctx.clip()
  ctx.strokeStyle = layout.waitColor
  ctx.lineWidth = Math.max(1, layout.px * 0.75)
  ctx.beginPath()
  for (let offset = -height; offset < width; offset += pitch) {
    ctx.moveTo(x + offset, y + height)
    ctx.lineTo(x + offset + height, y)
  }
  ctx.stroke()
  ctx.restore()
}

/** The y of the lane trace at step `t` (for the pen's dot and the watch marks). */
export function laneY(lanes: ChartLanes, layout: LaneLayout, lane: number, depth: number): number {
  const band = laneBands(lanes.model, layout)[lane]
  return band === undefined ? layout.baseline : depthToY(depth, band.scale)
}
