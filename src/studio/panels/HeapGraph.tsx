import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import type { FrameView, Recording, StateView } from '../../core/api-types'
import { useSelectedFrame, useStateView, useStudio, useStudioActions } from '../state/context'
import { formatCount, formatValue } from '../lib/format'
import {
  collectRoots,
  HEADER_H,
  layoutHeap,
  PAD_X,
  ROW_H,
  type BoxRow,
  type HeapBox,
  type HeapEdge,
  type HeapLayout,
  type LayoutMemory,
  type RootChip,
  type RootGroup,
} from '../lib/heap-layout'
import './heap.css'

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5
const ZOOM_STEP = 1.25
const PAN_STEP = 48
const WHEEL_RATE = 0.0015
const GRID = 16
const GROUP_NAMES: Record<RootGroup, string> = {
  local: 'Locals',
  capture: 'Captured',
  global: 'Globals',
}

type Hover =
  { readonly kind: 'box'; readonly id: number } | { readonly kind: 'root'; readonly key: string }

interface Transform {
  readonly x: number
  readonly y: number
  readonly k: number
}

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))

/** Heap graph of objects reachable from the selected frame and the globals, at the pen. */
export function HeapGraph() {
  const view = useStateView()
  const frame = useSelectedFrame()
  const recording = useStudio((s) => s.recording)
  const layout = useHeapLayout(view, frame, recording)
  if (!view || !recording || !layout) {
    return <Empty title="No recording yet" detail="Run a program to see the objects it builds." />
  }
  if (layout.boxes.length === 0) {
    return (
      <Empty
        title="No objects yet"
        detail="Heap graph shows lists, records and closures reachable from the selected frame and globals."
      />
    )
  }
  return <HeapCanvas layout={layout} recording={recording} truncated={view.heapTruncated} />
}

function Empty(props: { title: string; detail: string }) {
  return (
    <div className="hp-empty">
      <p className="hp-empty-title">{props.title}</p>
      <p className="hp-empty-detail">{props.detail}</p>
    </div>
  )
}

interface LayoutCache {
  readonly view: StateView | null
  readonly frame: FrameView | null
  readonly recording: Recording | null
  readonly layout: HeapLayout | null
}

/** Lays out the heap, carrying the box memory from one pen position to the next. */
function useHeapLayout(
  view: StateView | null,
  frame: FrameView | null,
  recording: Recording | null,
): HeapLayout | null {
  const [cache, setCache] = useState<LayoutCache | null>(null)
  if (cache && cache.view === view && cache.frame === frame && cache.recording === recording) {
    return cache.layout
  }
  const memory: LayoutMemory | null =
    cache?.recording === recording ? (cache.layout?.memory ?? null) : null
  const layout = view
    ? layoutHeap({ roots: collectRoots(frame, view.globals), heap: view.heap }, memory)
    : null
  // Storing information from the previous render (react.dev: "useState", "Storing information").
  setCache({ view, frame, recording, layout })
  return layout
}

function HeapCanvas(props: { layout: HeapLayout; recording: Recording; truncated: boolean }) {
  const { layout, recording } = props
  const [hover, setHover] = useState<Hover | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [readout, setReadout] = useState<string | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const viewport = useViewport(container, layout, recording)
  const ids = useId().replace(/:/g, '')
  const isHot = (edge: HeapEdge) =>
    edgeTouches(edge, hover) || edgeTouches(edge, selectedHover(selected))
  const edges = [...layout.edges].sort((a, b) => Number(isHot(a)) - Number(isHot(b)))
  const toggle = (id: number) => setSelected((current) => (current === id ? null : id))
  const t = viewport.transform

  return (
    <div className="hp-root">
      <Toolbar count={layout.boxes.length} onZoom={viewport.zoomBy} onFit={viewport.fit} />
      <div
        ref={container}
        className="hp-viewport"
        role="group"
        aria-label="Heap graph. Drag to pan, use the wheel or plus and minus to zoom, 0 to fit."
        tabIndex={0}
        onKeyDown={viewport.onKeyDown}
      >
        <svg className="hp-svg" width="100%" height="100%">
          <defs>
            <pattern
              id={`${ids}-grid`}
              width={GRID}
              height={GRID}
              patternUnits="userSpaceOnUse"
              patternTransform={`translate(${t.x} ${t.y}) scale(${t.k})`}
            >
              <path className="hp-grid" d={`M${GRID},0 L0,0 L0,${GRID}`} />
            </pattern>
            <Arrow id={`${ids}-arrow`} className="hp-arrow" />
            <Arrow id={`${ids}-arrow-hot`} className="hp-arrow is-hot" />
          </defs>
          <rect
            className="hp-ground"
            width="100%"
            height="100%"
            fill={`url(#${ids}-grid)`}
            onPointerDown={viewport.onPointerDown}
            onPointerMove={viewport.onPointerMove}
            onPointerUp={(event) => {
              if (!viewport.onPointerUp(event)) setSelected(null)
            }}
          />
          <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
            {layout.groupLabels.map((label) => (
              <text key={label.group} className="hp-group-label" x={0} y={label.y + 12}>
                {GROUP_NAMES[label.group]}
              </text>
            ))}
            {layout.roots.map((chip) => (
              <Chip key={chip.key} chip={chip} onHover={setHover} />
            ))}
            {layout.boxes.map((box) => (
              <Box
                key={box.id}
                box={box}
                selected={selected === box.id}
                onSelect={toggle}
                onHover={setHover}
                onReadout={setReadout}
              />
            ))}
            {edges.map((edge) => {
              const hot = isHot(edge)
              return (
                <path
                  key={edge.key}
                  className={hot ? 'hp-edge is-hot' : 'hp-edge'}
                  d={edge.path}
                  markerEnd={`url(#${ids}-arrow${hot ? '-hot' : ''})`}
                />
              )
            })}
          </g>
        </svg>
      </div>
      <Footer
        layout={layout}
        recording={recording}
        selected={selected}
        readout={readout}
        truncated={props.truncated}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}

function selectedHover(id: number | null): Hover | null {
  return id === null ? null : { kind: 'box', id }
}

function edgeTouches(edge: HeapEdge, hover: Hover | null): boolean {
  if (!hover) return false
  if (hover.kind === 'root') return edge.from.kind === 'root' && edge.from.key === hover.key
  return edge.to === hover.id || (edge.from.kind === 'box' && edge.from.id === hover.id)
}

function Arrow(props: { id: string; className: string }) {
  return (
    <marker
      id={props.id}
      className={props.className}
      viewBox="0 0 8 8"
      refX={7}
      refY={4}
      markerWidth={7}
      markerHeight={7}
      orient="auto-start-reverse"
    >
      <path d="M0,0 L8,4 L0,8 z" />
    </marker>
  )
}

function Toolbar(props: { count: number; onZoom: (factor: number) => void; onFit: () => void }) {
  return (
    <div className="hp-toolbar">
      <span className="hp-count">
        {formatCount(props.count)} {props.count === 1 ? 'object' : 'objects'}
      </span>
      <span className="hp-tools">
        <IconButton label="Zoom out" onClick={() => props.onZoom(1 / ZOOM_STEP)} d="M3,8 H13" />
        <IconButton label="Zoom in" onClick={() => props.onZoom(ZOOM_STEP)} d="M3,8 H13 M8,3 V13" />
        <IconButton
          label="Fit graph to panel"
          onClick={props.onFit}
          d="M2,6 V2 H6 M10,2 H14 V6 M14,10 V14 H10 M6,14 H2 V10"
        />
      </span>
    </div>
  )
}

function IconButton(props: { label: string; d: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="hp-icon-button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d={props.d} />
      </svg>
    </button>
  )
}

function Chip(props: { chip: RootChip; onHover: (hover: Hover | null) => void }) {
  const { chip } = props
  const tip = `${chip.name} = ${formatValue(chip.value)}`
  return (
    <g
      className="hp-chip"
      transform={`translate(${chip.x} ${chip.y})`}
      onMouseEnter={() => props.onHover({ kind: 'root', key: chip.key })}
      onMouseLeave={() => props.onHover(null)}
    >
      <title>{tip}</title>
      <rect className="hp-chip-frame" width={chip.width} height={chip.height} rx={2} />
      <text className="hp-chip-name" x={PAD_X} y={chip.height / 2 + 4}>
        {chip.name}
      </text>
      <text
        className={chip.port ? 'hp-chip-value is-ref' : 'hp-chip-value'}
        x={chip.width - PAD_X - (chip.port ? 10 : 0)}
        y={chip.height / 2 + 4}
        textAnchor="end"
      >
        {chip.text}
      </text>
      {chip.port && <Port x={chip.width - PAD_X} y={chip.height / 2} open={chip.target === null} />}
    </g>
  )
}

function Port(props: { x: number; y: number; open: boolean }) {
  return (
    <circle
      className={props.open ? 'hp-port is-open' : 'hp-port'}
      cx={props.x}
      cy={props.y}
      r={3}
    />
  )
}

function boxLabel(box: HeapBox): string {
  return `${box.title}, object ${box.id}`
}

function Box(props: {
  box: HeapBox
  selected: boolean
  onSelect: (id: number) => void
  onHover: (hover: Hover | null) => void
  onReadout: (text: string | null) => void
}) {
  const { box } = props
  const hover = () => props.onHover({ kind: 'box', id: box.id })
  const leave = () => props.onHover(null)
  const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    props.onSelect(box.id)
  }
  return (
    <g
      className={props.selected ? 'hp-box is-selected' : 'hp-box'}
      style={{ transform: `translate(${box.x}px, ${box.y}px)` }}
      role="button"
      tabIndex={0}
      aria-label={boxLabel(box)}
      aria-pressed={props.selected}
      onClick={() => props.onSelect(box.id)}
      onKeyDown={onKeyDown}
      onMouseEnter={hover}
      onMouseLeave={leave}
      onFocus={hover}
      onBlur={leave}
    >
      <rect className="hp-box-frame" width={box.width} height={box.height} rx={3} />
      <rect className="hp-box-header" width={box.width} height={HEADER_H} rx={3} />
      <text className="hp-box-title" x={PAD_X} y={HEADER_H / 2 + 4}>
        {box.title}
      </text>
      <text className="hp-box-id" x={box.width - PAD_X} y={HEADER_H / 2 + 4} textAnchor="end">
        #{box.id}
      </text>
      {box.rows.map((row, i) => (
        <Row key={row.key} box={box} row={row} first={i === 0} onReadout={props.onReadout} />
      ))}
    </g>
  )
}

function rowTip(box: HeapBox, row: BoxRow): string {
  if (row.value === null) return row.text
  const full = formatValue(row.value)
  if (box.type === 'list') return `[${row.label}] = ${full}`
  return `${row.label} = ${full}`
}

function Row(props: {
  box: HeapBox
  row: BoxRow
  first: boolean
  onReadout: (text: string | null) => void
}) {
  const { box, row } = props
  const tip = rowTip(box, row)
  const isRef = row.value?.kind === 'ref'
  const port = row.port ? { x: row.port.x - box.x, y: row.port.y - box.y } : null
  const valueX = box.horizontal ? row.x + row.width / 2 : row.label ? box.labelWidth : PAD_X
  const valueY = box.horizontal ? row.y + ROW_H + 4 : row.y + ROW_H / 2 + 4
  return (
    <g
      className={row.more ? 'hp-row is-more' : 'hp-row'}
      onMouseEnter={() => props.onReadout(tip)}
      onMouseLeave={() => props.onReadout(null)}
    >
      <title>{tip}</title>
      <rect className="hp-row-hit" x={row.x} y={row.y} width={row.width} height={row.height} />
      {box.horizontal && !props.first && (
        <line className="hp-rule" x1={row.x} y1={row.y} x2={row.x} y2={row.y + row.height} />
      )}
      {!box.horizontal && <line className="hp-rule" x1={0} y1={row.y} x2={box.width} y2={row.y} />}
      {row.label && (
        <text
          className="hp-row-label"
          x={box.horizontal ? row.x + 4 : PAD_X}
          y={box.horizontal ? row.y + 9 : valueY}
        >
          {row.label}
        </text>
      )}
      {!isRef && (
        <text
          className="hp-row-value"
          x={valueX}
          y={valueY}
          textAnchor={box.horizontal ? 'middle' : 'start'}
        >
          {row.text}
        </text>
      )}
      {port && <Port x={port.x} y={port.y} open={row.target === null} />}
    </g>
  )
}

function Footer(props: {
  layout: HeapLayout
  recording: Recording
  selected: number | null
  readout: string | null
  truncated: boolean
  onClose: () => void
}) {
  const { seek } = useStudioActions()
  const box = props.layout.boxes.find((b) => b.id === props.selected) ?? null
  const created = box ? props.recording.allocationTime(box.id) : null
  const notes = [
    props.layout.hiddenCount > 0
      ? `+${formatCount(props.layout.hiddenCount)} more objects not drawn`
      : null,
    props.truncated ? 'Some reachable objects are left out (heap view limit).' : null,
  ].filter((note): note is string => note !== null)
  return (
    <div className="hp-footer">
      {props.selected !== null && (
        <div className="hp-info" role="status">
          {box ? (
            <span className="hp-info-text">
              <span className="hp-info-name">
                {box.title} #{box.id}
              </span>
              {created === null
                ? ' · creation step not recorded'
                : ` · created at step ${formatCount(created)}`}
            </span>
          ) : (
            <span className="hp-info-text">The selected object is not reachable at this step.</span>
          )}
          {box && created !== null && (
            <button type="button" className="hp-button" onClick={() => seek(created)}>
              Jump
            </button>
          )}
          <button
            type="button"
            className="hp-icon-button"
            aria-label="Close object details"
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M4,4 L12,12 M12,4 L4,12" />
            </svg>
          </button>
        </div>
      )}
      {props.readout && <div className="hp-readout">{props.readout}</div>}
      {notes.map((note) => (
        <p key={note} className="hp-note">
          {note}
        </p>
      ))}
    </div>
  )
}

/** Pan and zoom state for the viewport; fits the graph when a new recording arrives. */
function useViewport(
  container: RefObject<HTMLDivElement | null>,
  layout: HeapLayout,
  recording: Recording,
) {
  const [transform, setTransform] = useState<Transform>({ x: 24, y: 24, k: 1 })
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const bounds = layout.bounds

  const fit = () => {
    const el = container.current
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
    const k = clampZoom(Math.min(1, el.clientWidth / bounds.width, el.clientHeight / bounds.height))
    setTransform({ x: -bounds.x * k, y: -bounds.y * k, k })
  }

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setTransform((t) => {
      const k = clampZoom(t.k * factor)
      return { k, x: cx - ((cx - t.x) * k) / t.k, y: cy - ((cy - t.y) * k) / t.k }
    })
  }, [])

  const zoomBy = (factor: number) => {
    const el = container.current
    zoomAt(factor, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2)
  }

  useFitOnNewRecording(recording, fit)
  useWheelZoom(container, zoomAt)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [PAN_STEP, 0],
      ArrowRight: [-PAN_STEP, 0],
      ArrowUp: [0, PAN_STEP],
      ArrowDown: [0, -PAN_STEP],
    }
    const delta = pan[event.key]
    if (delta) setTransform((t) => ({ ...t, x: t.x + delta[0], y: t.y + delta[1] }))
    else if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP)
    else if (event.key === '-') zoomBy(1 / ZOOM_STEP)
    else if (event.key === '0') fit()
    else return
    event.preventDefault()
  }

  const onPointerDown = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0) return
    drag.current = { x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const start = drag.current
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (!start.moved && Math.hypot(dx, dy) < 3) return
    drag.current = { x: event.clientX, y: event.clientY, moved: true }
    setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }))
  }
  /** Ends a drag; true when the pointer moved (a pan, not a click). */
  const onPointerUp = (event: ReactPointerEvent<SVGRectElement>): boolean => {
    const moved = drag.current?.moved ?? false
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    return moved
  }

  return { transform, fit, zoomBy, onKeyDown, onPointerDown, onPointerMove, onPointerUp }
}

function useFitOnNewRecording(recording: Recording, fit: () => void): void {
  const fitted = useRef<Recording | null>(null)
  useEffect(() => {
    if (fitted.current === recording) return
    fitted.current = recording
    fit()
  }, [recording, fit])
}

function useWheelZoom(
  container: RefObject<HTMLDivElement | null>,
  zoomAt: (factor: number, cx: number, cy: number) => void,
): void {
  useEffect(() => {
    const el = container.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(
        Math.exp(-event.deltaY * WHEEL_RATE),
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [container, zoomAt])
}
