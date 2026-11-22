/**
 * The Profile panel's model (ARCHITECTURE §11.3): the stack-path tree of a step profile flattened
 * for drawing (an icicle chart: the top level spans the width, each call level is a row below its
 * caller, widths by inclusive steps), hit-testing, labels and the table's figures. Pure functions.
 */
import type { ProfileNode } from '../../core/index'
import { type FlameNode, MAX_FLAME_NODES, MIN_FLAME_SHARE } from './insight-protocol'

export interface FlattenedFlame {
  readonly nodes: FlameNode[]
  readonly omitted: number
}

/**
 * The paths of `root` in pre-order with their left edges, leaving out paths narrower than
 * `minShare` of the root (and their subtrees) and everything past `maxNodes`. Iterative.
 */
export function flattenFlame(
  root: ProfileNode,
  maxNodes: number = MAX_FLAME_NODES,
  minShare: number = MIN_FLAME_SHARE,
): FlattenedFlame {
  const nodes: FlameNode[] = []
  const minSteps = root.inclusive * minShare
  let omitted = 0
  const work: { node: ProfileNode; depth: number; offset: number; parent: number }[] = [
    { node: root, depth: 0, offset: 0, parent: -1 },
  ]
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    const { node, depth, offset, parent } = item
    if (nodes.length >= maxNodes || (parent >= 0 && node.inclusive < minSteps)) {
      omitted += subtreeSize(node)
      continue
    }
    const index = nodes.length
    nodes.push({
      label: node.label,
      depth,
      offset,
      inclusive: node.inclusive,
      self: node.self,
      calls: node.calls,
      firstEntry: node.firstEntry,
      library: node.library,
      parent,
    })
    const placed: { node: ProfileNode; offset: number }[] = []
    let x = offset
    for (const child of node.children) {
      placed.push({ node: child, offset: x })
      x += child.inclusive
    }
    for (let i = placed.length - 1; i >= 0; i--) {
      work.push({
        node: placed[i]!.node,
        depth: depth + 1,
        offset: placed[i]!.offset,
        parent: index,
      })
    }
  }
  return { nodes, omitted }
}

function subtreeSize(root: ProfileNode): number {
  let count = 0
  const work = [root]
  for (let node = work.pop(); node !== undefined; node = work.pop()) {
    count += 1
    for (const child of node.children) work.push(child)
  }
  return count
}

/** The geometry of the chart in CSS pixels. */
export interface FlameGeometry {
  readonly width: number
  readonly rowHeight: number
  /** The steps the full width stands for (the top level's inclusive steps). */
  readonly total: number
}

export interface FlameBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export function flameBox(node: FlameNode, geometry: FlameGeometry): FlameBox {
  const scale = geometry.total > 0 ? geometry.width / geometry.total : 0
  return {
    x: node.offset * scale,
    y: node.depth * geometry.rowHeight,
    w: node.inclusive * scale,
    h: geometry.rowHeight,
  }
}

/** The deepest row of the chart (0 when there is only the top level). */
export function flameDepth(nodes: readonly FlameNode[]): number {
  let depth = 0
  for (const node of nodes) if (node.depth > depth) depth = node.depth
  return depth
}

/** The index of the node under (`x`, `y`), or -1. Nodes narrower than half a pixel are skipped. */
export function flameHit(
  nodes: readonly FlameNode[],
  geometry: FlameGeometry,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x > geometry.width) return -1
  const depth = Math.floor(y / geometry.rowHeight)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    if (node.depth !== depth) continue
    const box = flameBox(node, geometry)
    if (box.w >= 0.5 && x >= box.x && x < box.x + Math.max(box.w, 1)) return i
  }
  return -1
}

/** `fib (1,204 steps · 37 calls · 41.2%)`: what a hovered box says. */
export function shareText(part: number, total: number): string {
  if (total <= 0) return '0%'
  const share = (part / total) * 100
  if (share >= 99.95) return '100%'
  if (share > 0 && share < 0.1) return '<0.1%'
  return `${share.toFixed(1)}%`
}

/**
 * `label` cut to fit `room` pixels when each character takes about `charWidth` pixels; null when
 * not even two characters fit.
 */
export function fitLabel(label: string, room: number, charWidth: number): string | null {
  if (charWidth <= 0) return null
  const fits = Math.floor(room / charWidth)
  if (fits >= label.length) return label
  if (fits < 2) return null
  return `${label.slice(0, fits - 1)}…`
}

/** The path from the top level down to node `index`, as labels. */
export function flamePath(nodes: readonly FlameNode[], index: number): string[] {
  const labels: string[] = []
  for (let i = index; i >= 0 && i < nodes.length; i = nodes[i]!.parent) labels.push(nodes[i]!.label)
  return labels.reverse()
}
