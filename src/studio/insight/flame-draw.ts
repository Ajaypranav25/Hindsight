/**
 * Canvas drawing for the Profile panel's flame chart (an icicle: the top level on the first row,
 * callees below their callers). Every color comes from a token in `styles/tokens.css`, read at
 * paint time so both themes work.
 */
import type { FlameNode } from './insight-protocol'
import { fitLabel, flameBox, type FlameGeometry } from './profile-model'

const FLAME_TOKENS = {
  user: '--marker-soft',
  userEdge: '--marker',
  library: '--surface-sunken',
  gap: '--surface',
  text: '--ink',
  textMuted: '--ink-muted',
  hover: '--pen-soft',
  hoverEdge: '--pen',
  fontMono: '--font-mono',
} as const

export type FlameColors = { readonly [K in keyof typeof FLAME_TOKENS]: string }

/** The chart's colors and font from the CSS custom properties in effect at `element`. */
export function readFlameColors(element: Element): FlameColors {
  const style = getComputedStyle(element)
  const entries = Object.entries(FLAME_TOKENS).map(([key, token]) => [
    key,
    style.getPropertyValue(token).trim(),
  ])
  return Object.fromEntries(entries) as FlameColors
}

export interface FlameScene {
  readonly nodes: readonly FlameNode[]
  readonly geometry: FlameGeometry
  /** Rows drawn (deeper ones are left out). */
  readonly rows: number
  readonly dpr: number
  /** The hovered node's index, or -1. */
  readonly hover: number
  readonly colors: FlameColors
}

/** Labels are drawn only in boxes at least this wide (CSS pixels). */
export const LABEL_MIN_WIDTH = 24
const LABEL_FONT_PX = 11
const LABEL_PAD = 4

export function drawFlame(ctx: CanvasRenderingContext2D, scene: FlameScene): void {
  const { geometry, colors, dpr } = scene
  const height = scene.rows * geometry.rowHeight
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, geometry.width, height)
  ctx.font = `${LABEL_FONT_PX}px ${colors.fontMono || 'monospace'}`
  ctx.textBaseline = 'middle'
  const charWidth = ctx.measureText('M').width || LABEL_FONT_PX * 0.6
  scene.nodes.forEach((node, index) => {
    if (node.depth >= scene.rows) return
    const box = flameBox(node, geometry)
    if (box.w < 0.5) return
    const hovered = index === scene.hover
    ctx.fillStyle = hovered ? colors.hover : node.library ? colors.library : colors.user
    ctx.fillRect(box.x, box.y, Math.max(box.w, 1), box.h - 1)
    if (box.w >= 3) {
      ctx.fillStyle = hovered ? colors.hoverEdge : node.library ? colors.textMuted : colors.userEdge
      ctx.fillRect(box.x, box.y, 1, box.h - 1)
    }
    if (box.w > 2) {
      ctx.fillStyle = colors.gap
      ctx.fillRect(box.x + box.w - 1, box.y, 1, box.h - 1)
    }
    if (box.w < LABEL_MIN_WIDTH) return
    const label = fitLabel(node.label, box.w - 2 * LABEL_PAD, charWidth)
    if (label === null) return
    ctx.fillStyle = node.library ? colors.textMuted : colors.text
    ctx.fillText(label, box.x + LABEL_PAD, box.y + (box.h - 1) / 2)
  })
}
