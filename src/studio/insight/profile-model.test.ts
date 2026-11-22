import { describe, expect, test } from 'vitest'
import type { ProfileNode } from '../../core/index'
import { drawFlame, type FlameColors } from './flame-draw'
import {
  fitLabel,
  flameBox,
  flameDepth,
  flameHit,
  flamePath,
  flattenFlame,
  shareText,
} from './profile-model'

function node(
  label: string,
  inclusive: number,
  children: ProfileNode[] = [],
  extra: Partial<ProfileNode> = {},
): ProfileNode {
  const inner = children.reduce((sum, child) => sum + child.inclusive, 0)
  return {
    label,
    name: label,
    protoId: 0,
    library: false,
    calls: 1,
    inclusive,
    self: inclusive - inner,
    firstEntry: 0,
    children,
    ...extra,
  }
}

const TREE = node('<top level>', 100, [
  node('main', 80, [node('fib', 50, [], { firstEntry: 7 }), node('show', 20)]),
  node('print', 10, [], { library: true }),
])

describe('the flame chart is the stack-path tree laid out flat', () => {
  test('flattening keeps pre-order with each path placed after its earlier siblings', () => {
    // Arrange / Act
    const { nodes, omitted } = flattenFlame(TREE)

    // Assert
    expect(nodes.map((n) => [n.label, n.depth, n.offset, n.parent])).toEqual([
      ['<top level>', 0, 0, -1],
      ['main', 1, 0, 0],
      ['fib', 2, 0, 1],
      ['show', 2, 50, 1],
      ['print', 1, 80, 0],
    ])
    expect(nodes[2]!.firstEntry).toBe(7)
    expect(nodes[4]!.library).toBe(true)
    expect(omitted).toBe(0)
  })

  test('paths too narrow to see are left out with their subtrees, and counted', () => {
    const tree = node('<top level>', 10_000, [
      node('big', 9_999, []),
      node('tiny', 1, [node('tinier', 1)]),
    ])

    const { nodes, omitted } = flattenFlame(tree, 100, 1 / 1000)

    expect(nodes.map((n) => n.label)).toEqual(['<top level>', 'big'])
    expect(omitted).toBe(2)
  })

  test('the node cap stops the walk and counts what is left', () => {
    const { nodes, omitted } = flattenFlame(TREE, 2)

    expect(nodes.map((n) => n.label)).toEqual(['<top level>', 'main'])
    expect(omitted).toBe(3)
  })

  test('a very deep recursion flattens without recursing', () => {
    let deep = node('f', 1)
    for (let i = 0; i < 20_000; i++) deep = node('f', 1, [deep])

    const { nodes } = flattenFlame(node('<top level>', 1, [deep]), 50_000, 0)

    expect(flameDepth(nodes)).toBe(20_002 - 1)
  })
})

describe('geometry, hit testing and labels', () => {
  const { nodes } = flattenFlame(TREE)
  const geometry = { width: 200, rowHeight: 10, total: 100 }

  test('boxes scale inclusive steps to the width, one row per call level', () => {
    expect(flameBox(nodes[3]!, geometry)).toEqual({ x: 100, y: 20, w: 40, h: 10 })
    expect(flameBox(nodes[0]!, { ...geometry, total: 0 }).w).toBe(0)
    expect(flameDepth(nodes)).toBe(2)
    expect(flameDepth([])).toBe(0)
  })

  test('a point finds the box under it, or nothing', () => {
    expect(flameHit(nodes, geometry, 10, 25)).toBe(2)
    expect(flameHit(nodes, geometry, 120, 25)).toBe(3)
    expect(flameHit(nodes, geometry, 170, 15)).toBe(4)
    expect(flameHit(nodes, geometry, 170, 25)).toBe(-1)
    expect(flameHit(nodes, geometry, -1, 5)).toBe(-1)
    expect(flameHit(nodes, geometry, 201, 5)).toBe(-1)
  })

  test('shares read as percentages, with the extremes spelled out', () => {
    expect(shareText(41, 100)).toBe('41.0%')
    expect(shareText(100, 100)).toBe('100%')
    expect(shareText(1, 10_000)).toBe('<0.1%')
    expect(shareText(0, 100)).toBe('0.0%')
    expect(shareText(5, 0)).toBe('0%')
  })

  test('labels are cut with an ellipsis to fit, or dropped when nothing fits', () => {
    expect(fitLabel('fib', 60, 6)).toBe('fib')
    expect(fitLabel('average', 30, 6)).toBe('aver…')
    expect(fitLabel('average', 8, 6)).toBeNull()
    expect(fitLabel('average', 30, 0)).toBeNull()
  })

  test('a path reads from the top level down', () => {
    expect(flamePath(nodes, 3)).toEqual(['<top level>', 'main', 'show'])
    expect(flamePath(nodes, -1)).toEqual([])
  })
})

/** A 2D context that records what was drawn. */
function recordingContext() {
  const calls: string[] = []
  const ctx = {
    font: '',
    fillStyle: '',
    textBaseline: '',
    setTransform: () => calls.push('transform'),
    clearRect: () => calls.push('clear'),
    fillRect: (x: number, y: number, w: number) =>
      calls.push(`rect ${ctx.fillStyle} ${x} ${y} ${w}`),
    fillText: (text: string) => calls.push(`text ${text}`),
    measureText: () => ({ width: 6 }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

const COLORS: FlameColors = {
  user: 'U',
  userEdge: 'E',
  library: 'L',
  gap: 'G',
  text: 'T',
  textMuted: 'M',
  hover: 'H',
  hoverEdge: 'P',
  fontMono: 'mono',
}

describe('drawing the flame chart', () => {
  test('user boxes, library boxes and the hovered box take their own tokens', () => {
    const { nodes } = flattenFlame(TREE)
    const { ctx, calls } = recordingContext()

    drawFlame(ctx, {
      nodes,
      geometry: { width: 200, rowHeight: 18, total: 100 },
      rows: 3,
      dpr: 2,
      hover: 2,
      colors: COLORS,
    })

    expect(calls[0]).toBe('transform')
    expect(calls).toContain('rect U 0 0 200')
    expect(calls).toContain('rect H 0 36 100')
    expect(calls).toContain('rect L 160 18 20')
    expect(calls).toContain('text <top level>')
    expect(calls).toContain('text main')
    expect(calls).not.toContain('text print')
  })

  test('rows past the drawn depth and boxes under half a pixel are skipped', () => {
    const { nodes } = flattenFlame(
      node('<top level>', 10_000, [node('a', 9_999), node('b', 1)]),
      10,
      0,
    )
    const { ctx, calls } = recordingContext()

    drawFlame(ctx, {
      nodes,
      geometry: { width: 100, rowHeight: 18, total: 10_000 },
      rows: 1,
      dpr: 1,
      hover: -1,
      colors: { ...COLORS, fontMono: '' },
    })

    expect(calls.filter((call) => call.startsWith('rect U')).length).toBe(1)
    expect(calls.some((call) => call.includes('text a'))).toBe(false)
  })
})
