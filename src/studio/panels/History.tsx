import { useMemo, type KeyboardEvent } from 'react'
import type { HistoryResult, Recording, WriteTarget } from '../../core/index'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import {
  currentEventIndex,
  eventLabel,
  formatTraced,
  HISTORY_LIMIT,
  numericValues,
  sparkline,
} from './panel-logic'
import './panels.css'

const SPARK_WIDTH = 240
const SPARK_HEIGHT = 40

/** The watched binding's changes: a list (click to seek) and a sparkline for numbers. */
export function History() {
  const watch = useStudio((s) => s.watch)
  const recording = useStudio((s) => s.recording)
  const time = useStudio((s) => s.time)
  const { seek, setWatch } = useStudioActions()
  const result = useMemo(
    () => (recording && watch ? loadHistory(recording, watch.target, watch.at) : null),
    [recording, watch],
  )
  if (!watch || !recording) return null
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') setWatch(null)
  }
  return (
    <section className="pn-history" aria-label={`History of ${watch.label}`} onKeyDown={onKeyDown}>
      <header className="pn-history-head">
        <h3 className="pn-label">
          History · <span className="pn-history-name">{watch.label}</span>
        </h3>
        {result && <span className="pn-note">{changeCount(result.total)}</span>}
        <button
          type="button"
          className="pn-icon-btn"
          aria-label="Close history"
          title="Close history"
          onClick={() => setWatch(null)}
        >
          ×
        </button>
      </header>
      {result ? (
        <HistoryBody result={result} time={time} onSeek={seek} />
      ) : (
        <p className="pn-note pn-pad">History is not available for this run</p>
      )}
    </section>
  )
}

function loadHistory(recording: Recording, target: WriteTarget, at: number): HistoryResult | null {
  const clamped = Math.max(0, Math.min(at, recording.length))
  try {
    return recording.history(target, clamped, { limit: HISTORY_LIMIT })
  } catch {
    // The watched binding belongs to an earlier recording; there is nothing to list.
    return null
  }
}

function changeCount(total: number): string {
  return `${formatCount(total)} ${total === 1 ? 'change' : 'changes'}`
}

function HistoryBody(props: {
  readonly result: HistoryResult
  readonly time: number
  readonly onSeek: (time: number) => void
}) {
  const { result, time, onSeek } = props
  const { events } = result
  const current = currentEventIndex(events, time)
  const values = useMemo(() => numericValues(events), [events])
  if (events.length === 0) return <p className="pn-note pn-pad">No changes recorded</p>
  return (
    <>
      {result.truncated && (
        <p className="pn-note pn-pad">
          Showing {formatCount(events.length)} of {formatCount(result.total)}, evenly sampled
        </p>
      )}
      {values && <Spark values={values} current={current} />}
      <ol className="pn-history-list">
        {events.map((event, i) => (
          <li key={`${event.time}:${i}`}>
            <button
              type="button"
              className={`pn-event${event.time >= time ? ' pn-event--future' : ''}`}
              aria-current={i === current ? 'step' : undefined}
              onClick={() => onSeek(event.time)}
            >
              <span className="pn-stamp">{formatCount(event.time)}</span>
              <span className="pn-event-kind">{eventLabel(event)}</span>
              <span className="pn-value">{formatTraced(event.value)}</span>
            </button>
          </li>
        ))}
      </ol>
    </>
  )
}

function Spark(props: { readonly values: readonly number[]; readonly current: number }) {
  const { values, current } = props
  const geometry = useMemo(() => sparkline(values, SPARK_WIDTH, SPARK_HEIGHT), [values])
  const min = Math.min(...values)
  const max = Math.max(...values)
  const penX = current >= 0 ? geometry.xs[current] : undefined
  return (
    <figure className="pn-spark">
      <svg
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Values over ${values.length} changes, from ${min} to ${max}`}
      >
        <line
          className="pn-spark-base"
          x1={0}
          x2={SPARK_WIDTH}
          y1={geometry.baseline}
          y2={geometry.baseline}
        />
        <polygon className="pn-spark-area" points={geometry.area} />
        <polyline className="pn-spark-line" points={geometry.line} />
        {penX !== undefined && (
          <line className="pn-spark-pen" x1={penX} x2={penX} y1={0} y2={SPARK_HEIGHT} />
        )}
      </svg>
      <figcaption className="pn-note">
        min <span className="pn-value">{min}</span> · max <span className="pn-value">{max}</span>
      </figcaption>
    </figure>
  )
}
