/** Canvas drawing for the strip chart. Everything is drawn in device pixels. */
import {
  NO_DATA,
  axisTicks,
  depthScale,
  depthToY,
  envelope,
  markerColumns,
  multiplesIn,
  timeToX,
  type DepthEnvelope,
  type DepthScale,
  type Viewport,
} from '../lib/timeline-math'

/** Chart layout in CSS pixels. */
export const CHART_LAYOUT = {
  /** Output ticks live in this band at the top. */
  topMargin: 12,
  /** Step labels live in this band at the bottom; dragging it pans. */
  scaleHeight: 18,
  /** Gap between the depth-0 baseline and the scale. */
  baselineGap: 4,
  /** Tallest a single call level may be drawn. */
  maxDepthUnit: 14,
  /** Graph-paper pitch for the horizontal lines. */
  gridPitch: 10,
  /** Minimum spacing of labeled ticks. */
  tickSpacing: 84,
} as const

const COLOR_TOKENS = {
  gridMinor: '--grid-minor',
  gridMajor: '--grid-major',
  traceFill: '--trace-fill',
  traceLine: '--trace-line',
  pen: '--pen',
  penSoft: '--pen-soft',
  marker: '--marker',
  error: '--error',
  inkMuted: '--ink-muted',
  surface: '--surface',
  rule: '--rule',
  fontMono: '--font-mono',
} as const

export type ChartColors = { readonly [K in keyof typeof COLOR_TOKENS]: string }

/** Reads the chart's colors and mono font from the CSS custom properties in effect at `element`. */
export function readChartColors(element: Element): ChartColors {
  const style = getComputedStyle(element)
  const entries = Object.entries(COLOR_TOKENS).map(([key, token]) => [
    key,
    style.getPropertyValue(token).trim(),
  ])
  return Object.fromEntries(entries) as ChartColors
}

export interface ChartScene {
  /** CSS pixels. */
  readonly width: number
  readonly height: number
  readonly dpr: number
  readonly view: Viewport
  readonly length: number
  readonly env: DepthEnvelope | null
  readonly time: number
  readonly penDepth: number
  readonly outputTimes: ArrayLike<number>
  readonly breakpointTimes: ArrayLike<number>
  readonly watchTimes: ArrayLike<number>
  /** Time of the error flag, when the run ended in an error. */
  readonly errorAt: number | null
  readonly stale: boolean
  /** Share of the step budget recorded so far while a run records, else null. */
  readonly progress: number | null
  readonly colors: ChartColors
}

interface Frame {
  readonly ctx: CanvasRenderingContext2D
  readonly scene: ChartScene
  /** Device pixels. */
  readonly w: number
  readonly h: number
  readonly px: number
  readonly top: number
  readonly plotBottom: number
  readonly scale: DepthScale
}

export function drawChart(ctx: CanvasRenderingContext2D, scene: ChartScene): void {
  const px = scene.dpr
  const w = Math.round(scene.width * px)
  const h = Math.round(scene.height * px)
  const plotBottom = h - CHART_LAYOUT.scaleHeight * px
  const baseline = plotBottom - CHART_LAYOUT.baselineGap * px
  const top = CHART_LAYOUT.topMargin * px
  const scale = depthScale(
    scene.env?.maxDepth ?? 0,
    top + 4 * px,
    baseline,
    CHART_LAYOUT.maxDepthUnit * px,
  )
  const frame: Frame = { ctx, scene, w, h, px, top, plotBottom, scale }
  ctx.clearRect(0, 0, w, h)
  drawGrid(frame)
  ctx.globalAlpha = scene.stale ? 0.4 : 1
  drawTrace(frame)
  drawMarkers(frame)
  ctx.globalAlpha = 1
  drawScale(frame)
  if (scene.progress !== null) drawProgress(frame, scene.progress)
  else drawPen(frame)
}

function drawGrid(f: Frame): void {
  const { ctx, scene, w, px, plotBottom } = f
  const axis = axisTicks(scene.view, w, CHART_LAYOUT.tickSpacing * px)
  const minorPx = (axis.minor / (scene.view.end - scene.view.start)) * w
  if (minorPx >= 4 * px) {
    vLines(f, multiplesIn(scene.view.start, scene.view.end, axis.minor), scene.colors.gridMinor)
  }
  vLines(f, multiplesIn(scene.view.start, scene.view.end, axis.major), scene.colors.gridMajor)
  const pitch = CHART_LAYOUT.gridPitch * px
  for (let i = 0, y = f.scale.baseline; y > 0; i++, y -= pitch) {
    ctx.fillStyle = i % 5 === 0 ? scene.colors.gridMajor : scene.colors.gridMinor
    ctx.fillRect(0, Math.round(y), w, Math.max(1, Math.round(px * 0.75)))
  }
  ctx.fillStyle = scene.colors.rule
  ctx.fillRect(0, Math.round(plotBottom), w, Math.max(1, Math.round(px)))
}

function vLines(f: Frame, times: readonly number[], color: string): void {
  const { ctx, scene, w, px, plotBottom } = f
  ctx.fillStyle = color
  const lineWidth = Math.max(1, Math.round(px * 0.75))
  for (const t of times) {
    ctx.fillRect(Math.round(timeToX(t, scene.view, w)), 0, lineWidth, plotBottom)
  }
}

function drawTrace(f: Frame): void {
  const { ctx, scene, w, px, scale } = f
  if (!scene.env || scene.env.length === 0) return
  const cols = envelope(scene.env, scene.view.start, scene.view.end, w)
  ctx.fillStyle = scene.colors.traceFill
  ctx.beginPath()
  for (let c = 0; c < w; c++) {
    if (cols.max[c] === NO_DATA) continue
    const y = depthToY(cols.max[c]!, scale)
    ctx.rect(c, y, 1, scale.baseline - y)
  }
  ctx.fill()
  const lineWidth = Math.max(1, Math.round(px * 1.25))
  ctx.fillStyle = scene.colors.traceLine
  ctx.beginPath()
  let prevMin = NO_DATA
  let prevMax = NO_DATA
  for (let c = 0; c < w; c++) {
    const min = cols.min[c]!
    const max = cols.max[c]!
    if (max === NO_DATA) continue
    const lo = prevMax === NO_DATA ? min : Math.min(min, prevMax)
    const hi = prevMin === NO_DATA ? max : Math.max(max, prevMin)
    const yTop = Math.round(depthToY(hi, scale))
    const yBottom = Math.round(depthToY(lo, scale))
    ctx.rect(c, yTop - lineWidth / 2, 1, yBottom - yTop + lineWidth)
    prevMin = min
    prevMax = max
  }
  ctx.fill()
}

function drawMarkers(f: Frame): void {
  const { ctx, scene, w, px, top, scale } = f
  ctx.fillStyle = scene.colors.marker
  for (const x of markerColumns(scene.outputTimes, scene.view, w)) {
    ctx.fillRect(x, top - 9 * px, Math.max(1, Math.round(px)), 7 * px)
  }
  let lastDot = -Infinity
  ctx.beginPath()
  for (const x of markerColumns(scene.breakpointTimes, scene.view, w)) {
    if (x - lastDot < 5 * px) continue
    lastDot = x
    ctx.moveTo(x + 2.25 * px, scale.baseline)
    ctx.arc(x, scale.baseline, 2.25 * px, 0, Math.PI * 2)
  }
  ctx.fill()
  drawWatch(f)
  if (scene.errorAt !== null) drawErrorFlag(f, scene.errorAt)
}

function drawWatch(f: Frame): void {
  const { ctx, scene, w, px, scale } = f
  const depths = scene.env?.mins[0]
  const r = 3.5 * px
  ctx.fillStyle = scene.colors.marker
  ctx.strokeStyle = scene.colors.surface
  ctx.lineWidth = px
  let lastX = -Infinity
  for (let i = 0; i < scene.watchTimes.length; i++) {
    const t = scene.watchTimes[i]!
    if (t < scene.view.start || t > scene.view.end) continue
    const x = timeToX(t, scene.view, w)
    if (x - lastX < 2 * px) continue
    lastX = x
    const y = depthToY(depths && t < depths.length ? depths[t]! : 0, scale)
    ctx.beginPath()
    ctx.moveTo(x, y - r)
    ctx.lineTo(x + r, y)
    ctx.lineTo(x, y + r)
    ctx.lineTo(x - r, y)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
}

function drawErrorFlag(f: Frame, at: number): void {
  const { ctx, scene, w, px, top, scale } = f
  if (at < scene.view.start || at > scene.view.end) return
  const x = Math.min(w - 9 * px, Math.round(timeToX(at, scene.view, w)))
  ctx.fillStyle = scene.colors.error
  ctx.fillRect(x, top, Math.max(1, Math.round(1.5 * px)), scale.baseline - top)
  ctx.beginPath()
  ctx.moveTo(x, top)
  ctx.lineTo(x + 9 * px, top + 3.5 * px)
  ctx.lineTo(x, top + 7 * px)
  ctx.closePath()
  ctx.fill()
}

function drawScale(f: Frame): void {
  const { ctx, scene, w, h, px, plotBottom } = f
  const axis = axisTicks(scene.view, w, CHART_LAYOUT.tickSpacing * px)
  ctx.font = `${10 * px}px ${scene.colors.fontMono || 'monospace'}`
  ctx.textBaseline = 'middle'
  ctx.fillStyle = scene.colors.inkMuted
  const mid = (plotBottom + h) / 2
  for (const tick of axis.ticks) {
    const x = Math.round(tick.x)
    ctx.fillRect(x, plotBottom, Math.max(1, Math.round(px)), 3 * px)
    const width = ctx.measureText(tick.label).width
    ctx.textAlign = 'left'
    const textX = Math.min(Math.max(x + 3 * px, 2 * px), w - width - 2 * px)
    ctx.fillText(tick.label, textX, mid + px)
  }
}

function drawPen(f: Frame): void {
  const { ctx, scene, w, px, top, scale } = f
  if (scene.length === 0 && !scene.env) return
  const x = timeToX(scene.time, scene.view, w)
  if (x < -4 * px || x > w + 4 * px) return
  const lineX = Math.round(Math.min(Math.max(x, px), w - px))
  ctx.fillStyle = scene.colors.pen
  const lineWidth = Math.max(1, Math.round(1.5 * px))
  ctx.fillRect(
    lineX - Math.floor(lineWidth / 2),
    top - 6 * px,
    lineWidth,
    scale.baseline - top + 6 * px,
  )
  ctx.beginPath()
  ctx.moveTo(lineX - 4.5 * px, 0)
  ctx.lineTo(lineX + 4.5 * px, 0)
  ctx.lineTo(lineX, top - 4 * px)
  ctx.closePath()
  ctx.fill()
  const y = depthToY(scene.penDepth, scale)
  ctx.beginPath()
  ctx.arc(lineX, y, 3.5 * px, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = scene.colors.surface
  ctx.lineWidth = 1.25 * px
  ctx.stroke()
}

function drawProgress(f: Frame, fraction: number): void {
  const { ctx, scene, w, px, top, scale } = f
  const x = Math.round(fraction * w)
  ctx.fillStyle = scene.colors.penSoft
  ctx.fillRect(0, top, x, scale.baseline - top)
  ctx.fillStyle = scene.colors.pen
  ctx.fillRect(
    Math.max(0, x - px),
    top - 6 * px,
    Math.max(1, Math.round(1.5 * px)),
    scale.baseline - top + 6 * px,
  )
  ctx.fillRect(0, scale.baseline - px, x, Math.max(1, Math.round(1.5 * px)))
}
