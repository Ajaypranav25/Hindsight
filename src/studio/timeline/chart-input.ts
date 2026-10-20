/** Pointer, wheel and keyboard handling for the strip chart. */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import type { StudioActions } from '../state/types'
import {
  fullViewport,
  panBy,
  stepAtX,
  xToTime,
  zoomAround,
  type Viewport,
} from '../lib/timeline-math'
import { CHART_LAYOUT } from './chart-draw'
import type { ViewUpdate } from './chart-data'

export interface Hover {
  /** CSS pixels from the chart's left edge. */
  readonly x: number
  readonly step: number
}

interface ChartInputOptions {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  readonly view: Viewport
  readonly setView: ViewUpdate
  readonly width: number
  readonly height: number
  readonly length: number
  readonly enabled: boolean
  readonly actions: StudioActions
  /** The hover is dropped when this changes (a new recording may be shorter than its step). */
  readonly resetKey: unknown
}

type Drag =
  | { readonly mode: 'seek' }
  | { readonly mode: 'pan'; readonly startX: number; readonly startView: Viewport }

const WHEEL_ZOOM_RATE = 0.0015
const LINE_HEIGHT_PX = 16
const KEY_ZOOM_FACTOR = 0.5

function localPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect()
  return { x: clientX - rect.left, y: clientY - rect.top }
}

export function useChartInput(options: ChartInputOptions) {
  const { canvasRef, view, setView, width, height, length, enabled, actions, resetKey } = options
  const drag = useRef<Drag | null>(null)
  const [hoverState, setHoverState] = useState<{ key: unknown; hover: Hover } | null>(null)
  const hover = hoverState !== null && hoverState.key === resetKey ? hoverState.hover : null
  const setHover = (next: Hover | null) =>
    setHoverState(next ? { key: resetKey, hover: next } : null)

  useWheel(canvasRef, setView, width, length, enabled)

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!enabled || event.button !== 0) return
    const canvas = event.currentTarget
    const { x, y } = localPoint(canvas, event.clientX, event.clientY)
    canvas.focus()
    canvas.setPointerCapture?.(event.pointerId)
    if (y >= height - CHART_LAYOUT.scaleHeight) {
      drag.current = { mode: 'pan', startX: x, startView: view }
      return
    }
    drag.current = { mode: 'seek' }
    actions.stopPlay()
    actions.seek(stepAtX(x, view, width, length))
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!enabled) return
    const { x } = localPoint(event.currentTarget, event.clientX, event.clientY)
    const current = drag.current
    if (current?.mode === 'pan') {
      const span = current.startView.end - current.startView.start
      const delta = -((x - current.startX) / Math.max(1, width)) * span
      setView(() => panBy(current.startView, delta, length))
    } else if (current?.mode === 'seek') {
      actions.seek(stepAtX(x, view, width, length))
    }
    setHover({ x, step: stepAtX(x, view, width, length) })
  }

  const endDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!enabled || event.altKey || event.ctrlKey || event.metaKey) return
    const handled = handleKey(event.key, event.shiftKey, actions, setView, length)
    if (handled) event.preventDefault()
  }

  return {
    hover,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onPointerLeave: () => setHover(null),
      onDoubleClick: () => setView(() => fullViewport(length)),
      onKeyDown,
    },
  }
}

function handleKey(
  key: string,
  shift: boolean,
  actions: StudioActions,
  setView: ViewUpdate,
  length: number,
): boolean {
  const kind = shift ? 'over' : 'into'
  const zoomAtCenter = (factor: number) =>
    setView((v) => zoomAround(v, (v.start + v.end) / 2, factor, length))
  switch (key) {
    case 'ArrowLeft':
      actions.stepNav(kind, 'backward')
      return true
    case 'ArrowRight':
      actions.stepNav(kind, 'forward')
      return true
    case 'Home':
      actions.jumpToStart()
      return true
    case 'End':
      actions.jumpToEnd()
      return true
    case '+':
    case '=':
      zoomAtCenter(KEY_ZOOM_FACTOR)
      return true
    case '-':
    case '_':
      zoomAtCenter(1 / KEY_ZOOM_FACTOR)
      return true
    case '0':
      setView(() => fullViewport(length))
      return true
    default:
      return false
  }
}

/** Wheel zooms around the cursor; Shift+wheel (or a horizontal wheel) pans. Non-passive. */
function useWheel(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  setView: ViewUpdate,
  width: number,
  length: number,
  enabled: boolean,
) {
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !enabled) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? width : 1
      const dx = event.deltaX * unit
      const dy = event.deltaY * unit
      const { x } = localPoint(canvas, event.clientX, event.clientY)
      if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        const pixels = Math.abs(dx) > Math.abs(dy) ? dx : dy
        setView((v) => panBy(v, (pixels / Math.max(1, width)) * (v.end - v.start), length))
        return
      }
      const factor = Math.exp(dy * WHEEL_ZOOM_RATE)
      setView((v) => zoomAround(v, xToTime(x, v, width), factor, length))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [canvasRef, setView, width, length, enabled])
}
