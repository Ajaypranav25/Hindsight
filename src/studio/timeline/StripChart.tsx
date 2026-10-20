/** The strip chart: the run's call depth on graph paper, with the pen at the current time. */
import { useId, useMemo, useRef } from 'react'
import type { Recording } from '../../core/api-types'
import { formatCount } from '../lib/format'
import {
  axisTicks,
  chartSpeedText,
  fullViewport,
  isZoomed,
  locationText,
  recordingFraction,
  stepValueText,
} from '../lib/timeline-math'
import { useStudio, useStudioActions } from '../state/context'
import { isStale } from '../state/selectors'
import type { RunStatus } from '../state/types'
import { useChartData, useViewport } from './chart-data'
import { CHART_LAYOUT } from './chart-draw'
import { useChartInput, type Hover } from './chart-input'
import { useChartPaint } from './chart-paint'
import { useElementSize, usePrefersReducedMotion, useThemeVersion } from './hooks'
import './timeline.css'

/** Progress toward the step budget; extensions continue past earlier multiples of it. */
function progressOf(status: RunStatus, maxSteps: number): number | null {
  if (status.kind !== 'recording') return null
  const budget = maxSteps * Math.max(1, Math.ceil(status.progress / maxSteps))
  return recordingFraction(status.progress, budget)
}

function penDepth(recording: Recording | null, time: number): number {
  if (!recording || time < 0 || time > recording.length) return 0
  return recording.depthAt(time)
}

export function StripChart() {
  const recording = useStudio((s) => s.recording)
  const time = useStudio((s) => s.time)
  const status = useStudio((s) => s.status)
  const stale = useStudio(isStale)
  const maxSteps = useStudio((s) => s.settings.maxSteps)
  const actions = useStudioActions()
  const data = useChartData(recording)
  const helpId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(wrapRef)
  const themeVersion = useThemeVersion()
  const reducedMotion = usePrefersReducedMotion()
  const [view, setView] = useViewport(recording, time)
  const length = recording?.length ?? 0
  const progress = progressOf(status, maxSteps)
  const depth = penDepth(recording, time)
  const errorAt = recording?.outcome.kind === 'error' ? length : null

  const paintInput = useMemo(
    () => ({
      ...size,
      ...data,
      view,
      length,
      time,
      penDepth: depth,
      errorAt,
      stale,
      progress,
      reducedMotion,
      themeVersion,
    }),
    [size, data, view, length, time, depth, errorAt, stale, progress, reducedMotion, themeVersion],
  )
  useChartPaint(canvasRef, paintInput)

  const { hover, handlers } = useChartInput({
    canvasRef,
    view,
    setView,
    width: size.width,
    height: size.height,
    length,
    enabled: recording !== null,
    actions,
    resetKey: recording,
  })

  const location = useMemo(
    () => (recording ? recording.locationAt(Math.min(time, recording.length)) : null),
    [recording, time],
  )
  const speed = chartSpeedText(axisTicks(view, size.width, CHART_LAYOUT.tickSpacing).major)
  const zoomed = recording !== null && isZoomed(view, length)
  const className = ['tl-chart', stale ? 'tl-chart--stale' : '', recording ? '' : 'tl-chart--empty']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className}>
      <div className="tl-chart__paper" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="tl-chart__canvas"
          role="slider"
          tabIndex={0}
          aria-label="Time"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={length}
          aria-valuenow={time}
          aria-valuetext={recording ? stepValueText(time, length, location) : 'no recording'}
          aria-disabled={recording ? undefined : true}
          aria-describedby={helpId}
          {...handlers}
        />
        {hover && recording && (
          <ChartTooltip hover={hover} recording={recording} width={size.width} />
        )}
        {!recording && progress === null && (
          <p className="tl-chart__empty">Run a program to trace its call depth here</p>
        )}
      </div>
      <div className="tl-chart__readouts">
        <span className="tl-chart__label">Depth</span>
        {status.kind === 'recording' ? (
          <span className="tl-chart__recording">
            Recording · {formatCount(status.progress)} steps
          </span>
        ) : (
          stale && <span className="tl-chart__label">Stale · edit not yet recorded</span>
        )}
        <span className="tl-chart__speed">{speed}</span>
        {zoomed && (
          <button
            type="button"
            className="tl-chart__reset"
            onClick={() => setView(() => fullViewport(length))}
          >
            Show whole run
          </button>
        )}
      </div>
      <p id={helpId} className="tl-visually-hidden">
        Left and right arrows step into, Shift with arrows steps over, Home and End jump to the
        ends, plus and minus zoom, 0 shows the whole run.
      </p>
    </div>
  )
}

function ChartTooltip(props: { hover: Hover; recording: Recording; width: number }) {
  const { hover, recording, width } = props
  const step = Math.max(0, Math.min(recording.length, hover.step))
  const location = recording.locationAt(step)
  const flip = hover.x > width - 160
  return (
    <div
      className={flip ? 'tl-chart__tooltip tl-chart__tooltip--flip' : 'tl-chart__tooltip'}
      style={{ left: `${Math.round(hover.x)}px` }}
      aria-hidden="true"
    >
      <span className="tl-chart__tooltip-step">step {formatCount(step)}</span>
      <span>{locationText(location)}</span>
    </div>
  )
}
