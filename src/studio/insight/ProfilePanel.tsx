/**
 * The Profile panel (ARCHITECTURE §11.3): where the shown run spent its steps. A flame chart (an
 * icicle drawn on canvas: stack paths aggregated from the call tree, widths by inclusive steps)
 * whose boxes say their name, steps, calls and share on hover and move the pen to the first call
 * of their path on click, and a table of functions and lines as the accessible view. The profile
 * is computed by the analysis service once the run is on screen.
 */
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { FunctionProfile } from '../../core/index'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import { useElementSize, useThemeVersion } from '../timeline/hooks'
import { drawFlame, readFlameColors } from './flame-draw'
import type { FlameNode, ProfileSummary } from './insight-protocol'
import {
  flameBox,
  flameDepth,
  flameHit,
  type FlameGeometry,
  flamePath,
  shareText,
} from './profile-model'
import { useInsight } from './use-insight'
import './insight.css'

/** Height of one call level, CSS pixels. */
export const FLAME_ROW_PX = 18
/** Call levels drawn; deeper ones are summarized in a note. */
export const FLAME_MAX_ROWS = 160
/** Rows of the functions table. */
const TABLE_ROWS = 50

type View = 'flame' | 'table'

export function ProfilePanel() {
  const recording = useStudio((s) => s.recording)
  const justMyCode = useStudio((s) => s.settings.justMyCode)
  const stale = useStudio((s) => s.recordedSource !== s.source)
  const request = useMemo(() => ({ kind: 'profile' as const, justMyCode }), [justMyCode])
  const state = useInsight(recording, request)
  const [view, setView] = useState<View>('flame')
  if (recording === null) return <p className="pn-empty">Run the program to profile it</p>
  if (state.status === 'failed') {
    return <p className="pn-empty">The profile could not be computed: {state.error}</p>
  }
  if (state.status !== 'done') return <p className="pn-empty">Profiling…</p>
  const summary = state.value.profile
  return (
    <div className="in-profile">
      <div className="in-profile-head">
        <span className="in-profile-text">
          {formatCount(summary.steps)} steps · {formatCount(summary.functionsTotal)}{' '}
          {summary.functionsTotal === 1 ? 'function' : 'functions'}
          {summary.justMyCode ? ' · just my code' : ''}
          {stale ? ' · last run' : ''}
        </span>
        <div className="in-toggle" role="group" aria-label="Profile view">
          <button
            type="button"
            className="ch-button ch-button-small"
            aria-pressed={view === 'flame'}
            onClick={() => setView('flame')}
          >
            Flame chart
          </button>
          <button
            type="button"
            className="ch-button ch-button-small"
            aria-pressed={view === 'table'}
            onClick={() => setView('table')}
          >
            Table
          </button>
        </div>
      </div>
      {view === 'flame' ? <FlameChart summary={summary} /> : <ProfileTable summary={summary} />}
    </div>
  )
}

function FlameChart(props: { readonly summary: ProfileSummary }) {
  const { summary } = props
  const nodes = summary.flame
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(hostRef)
  const theme = useThemeVersion()
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)
  const { seek } = useStudioActions()
  const depth = useMemo(() => flameDepth(nodes), [nodes])
  const rows = Math.min(depth + 1, FLAME_MAX_ROWS)
  const total = nodes[0]?.inclusive ?? 0
  const geometry: FlameGeometry = useMemo(
    () => ({ width: size.width, rowHeight: FLAME_ROW_PX, total }),
    [size.width, total],
  )
  const hovered = hover === null ? -1 : hover.index
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || geometry.width <= 0) return
    const width = Math.round(geometry.width * size.dpr)
    const height = Math.round(rows * FLAME_ROW_PX * size.dpr)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    drawFlame(ctx, {
      nodes,
      geometry,
      rows,
      dpr: size.dpr,
      hover: hovered,
      colors: readFlameColors(canvas),
    })
  }, [nodes, geometry, rows, size.dpr, hovered, theme])

  const pointAt = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    return { index: flameHit(nodes, geometry, x, y), x, y }
  }
  const onMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = pointAt(event)
    setHover(point.index < 0 ? null : point)
  }
  const onClick = (event: PointerEvent<HTMLCanvasElement>) => {
    const { index } = pointAt(event)
    if (index >= 0) seek(nodes[index]!.firstEntry)
  }
  const top = nodes[0]
  const label = top
    ? `Flame chart of ${formatCount(total)} steps; the heaviest function is ${summary.functions[0]?.label ?? top.label}. The table lists every function.`
    : 'Empty flame chart'
  return (
    <div className="in-flame" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="in-flame-canvas"
        role="img"
        aria-label={label}
        style={{ height: `${rows * FLAME_ROW_PX}px` }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onClick={onClick}
        data-hover={hovered}
      />
      {hover !== null && nodes[hover.index] && (
        <FlameTip
          node={nodes[hover.index]!}
          index={hover.index}
          nodes={nodes}
          total={total}
          at={hover}
          geometry={geometry}
        />
      )}
      {depth + 1 > rows && (
        <p className="pn-note pn-pad">
          {formatCount(depth + 1 - rows)} deeper call levels are not drawn
        </p>
      )}
      {summary.flameOmitted > 0 && (
        <p className="pn-note pn-pad">
          {formatCount(summary.flameOmitted)} stack paths too narrow to see are left out
        </p>
      )}
    </div>
  )
}

function FlameTip(props: {
  readonly node: FlameNode
  readonly index: number
  readonly nodes: readonly FlameNode[]
  readonly total: number
  readonly at: { readonly x: number; readonly y: number }
  readonly geometry: FlameGeometry
}) {
  const { node, total, at, geometry } = props
  const box = flameBox(node, geometry)
  const path = flamePath(props.nodes, props.index)
  const left = Math.max(0, Math.min(at.x + 12, geometry.width - 220))
  return (
    <div className="in-flame-tip" role="status" style={{ left, top: box.y + box.h + 4 }}>
      <span className="in-flame-tip-name">{node.label}</span>
      <span>
        {formatCount(node.inclusive)} steps · {formatCount(node.calls)}{' '}
        {node.calls === 1 ? 'call' : 'calls'} · {shareText(node.inclusive, total)}
      </span>
      {path.length > 2 && <span className="in-flame-tip-path">{path.slice(1).join(' › ')}</span>}
      <span className="in-flame-tip-hint">Click: go to its first call</span>
    </div>
  )
}

function ProfileTable(props: { readonly summary: ProfileSummary }) {
  const { summary } = props
  const { seek } = useStudioActions()
  const shown = summary.functions.slice(0, TABLE_ROWS)
  return (
    <div className="in-table-wrap">
      <table className="in-table">
        <caption className="in-caption">Functions by inclusive steps</caption>
        <thead>
          <tr>
            <th scope="col">Function</th>
            <th scope="col">Calls</th>
            <th scope="col">Inclusive</th>
            <th scope="col">Own</th>
            <th scope="col">Avg / call</th>
            <th scope="col">Max</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((fn) => (
            <FunctionRow key={fn.protoId} fn={fn} steps={summary.steps} onGo={seek} />
          ))}
        </tbody>
      </table>
      {summary.functionsTotal > shown.length && (
        <p className="pn-note pn-pad">
          {formatCount(summary.functionsTotal - shown.length)} more functions not listed
        </p>
      )}
      {summary.lines.length > 0 && (
        <table className="in-table">
          <caption className="in-caption">Busiest lines</caption>
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Steps</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {summary.lines.slice(0, 12).map((line) => (
              <tr key={line.line}>
                <td>{line.line}</td>
                <td>{formatCount(line.steps)}</td>
                <td>{shareText(line.steps, summary.steps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function FunctionRow(props: {
  readonly fn: FunctionProfile
  readonly steps: number
  readonly onGo: (time: number) => void
}) {
  const { fn, steps, onGo } = props
  return (
    <tr className={fn.library ? 'in-row-library' : undefined}>
      <th scope="row">
        <button
          type="button"
          className="in-link"
          title="Go to its first call"
          onClick={() => onGo(fn.firstEntry)}
        >
          {fn.label}
        </button>
        {fn.lines !== null && <span className="in-dim"> · line {fn.lines.start}</span>}
      </th>
      <td>{formatCount(fn.calls)}</td>
      <td>{formatCount(fn.inclusive)}</td>
      <td>{formatCount(fn.exclusive)}</td>
      <td>{formatCount(Math.round(fn.average))}</td>
      <td>{formatCount(fn.max)}</td>
      <td>{shareText(fn.inclusive, steps)}</td>
    </tr>
  )
}
