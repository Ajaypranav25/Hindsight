/**
 * Ghost edges for the heap graph (ARCHITECTURE §7.13, §11.3): during a what-if, the references of
 * the what-if's heap are compared with the real run's at the same step. References only the
 * what-if has are marked as added; references only the real run has are drawn into the what-if's
 * layout as dashed ghosts, from where their holder sits now to where their target sits now (or as
 * a short stub when the target is not drawn). Pure: both layouts in, marks and paths out.
 */
import {
  edgePath,
  HEADER_H,
  type HeapBox,
  type HeapEdge,
  type HeapLayout,
  type Point,
} from './heap-layout'

export interface GhostEdge {
  readonly key: string
  /** SVG path data. */
  readonly path: string
  /** False when the target is not in the drawn layout: the path is a stub. */
  readonly reaches: boolean
}

export interface HeapLayoutDiff {
  /** Keys of the layout's edges the real run does not have. */
  readonly added: ReadonlySet<string>
  /** The real run's references the what-if lost, drawn into the what-if's layout. */
  readonly removed: readonly GhostEdge[]
  /** "start.next now points to #7", for the accessible description. */
  readonly addedTexts: readonly string[]
  /** "start.next pointed to #4". */
  readonly removedTexts: readonly string[]
}

/** The length of the stub drawn for a lost reference whose target is not in the layout. */
const STUB = 36

/** What identifies a reference in both runs: its holder, its slot and what it points at. */
function signature(edge: HeapEdge): string {
  return `${edge.key}>${edge.to}`
}

/** `xs`, `#12 [0]`, `#12 next`: the holder of a reference, as the graph labels it. */
function holderText(layout: HeapLayout, edge: HeapEdge): string {
  if (edge.from.kind === 'root') {
    const key = edge.from.key
    return layout.roots.find((chip) => chip.key === key)?.name ?? 'a variable'
  }
  const id = edge.from.id
  const box = layout.boxes.find((candidate) => candidate.id === id)
  const row = box?.rows.find((candidate) => `b:${id}:${candidate.key}` === edge.key)
  const label = row === undefined || row.label === '' ? '' : ` ${row.label}`
  return `#${id}${label}`
}

/** Where a lost reference starts in the what-if's layout: its row or chip, else its box's edge. */
function portOf(layout: HeapLayout, edge: HeapEdge): { port: Point; box: HeapBox | null } | null {
  if (edge.from.kind === 'root') {
    const key = edge.from.key
    const chip = layout.roots.find((candidate) => candidate.key === key)
    if (chip === undefined) return null
    const port = chip.port ?? { x: chip.x + chip.width, y: chip.y + chip.height / 2 }
    return { port, box: null }
  }
  const id = edge.from.id
  const box = layout.boxes.find((candidate) => candidate.id === id)
  if (box === undefined) return null
  const row = box.rows.find((candidate) => `b:${id}:${candidate.key}` === edge.key)
  const port = row?.port ??
    (row && { x: row.x + row.width, y: row.y + row.height / 2 }) ?? {
      x: box.x + box.width,
      y: box.y + HEADER_H / 2,
    }
  return { port, box }
}

/** Compares the what-if's `layout` with the layout of the real run's state at the same step. */
export function diffLayouts(layout: HeapLayout, real: HeapLayout): HeapLayoutDiff {
  const realSignatures = new Set(real.edges.map(signature))
  const signatures = new Set(layout.edges.map(signature))
  const added = new Set<string>()
  const addedTexts: string[] = []
  for (const edge of layout.edges) {
    if (realSignatures.has(signature(edge))) continue
    added.add(edge.key)
    addedTexts.push(`${holderText(layout, edge)} now points to #${edge.to}`)
  }
  const removed: GhostEdge[] = []
  const removedTexts: string[] = []
  const boxes = new Map(layout.boxes.map((box) => [box.id, box]))
  for (const edge of real.edges) {
    if (signatures.has(signature(edge))) continue
    removedTexts.push(`${holderText(real, edge)} pointed to #${edge.to}`)
    const from = portOf(layout, edge)
    if (from === null) continue
    const to = boxes.get(edge.to)
    if (to === undefined) {
      const { x, y } = from.port
      removed.push({ key: `gone:${edge.key}`, path: `M${x},${y} h${STUB}`, reaches: false })
      continue
    }
    const route =
      from.box === null || to.column > from.box.column
        ? 'forward'
        : to.id === from.box.id
          ? 'self'
          : 'back'
    removed.push({ key: `gone:${edge.key}`, path: edgePath(from.port, to, route), reaches: true })
  }
  return { added, removed, addedTexts, removedTexts }
}

/** True when the two heaps hold the same references. */
export function sameReferences(diff: HeapLayoutDiff): boolean {
  return diff.added.size === 0 && diff.removedTexts.length === 0
}
