/**
 * The query bar (ARCHITECTURE §7.9, §11.3): jump to moments by what was true then. Enter runs the
 * query against the run on display; its matches are marked on the strip chart, counted beside the
 * field, stepped through with Previous and Next, and listed on request.
 */
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react'
import {
  type ProvenanceEvent,
  queryRecording,
  type QueryResult,
  queryTimes,
  type Recording,
  type TracedValue,
  writeName,
} from '../../core/index'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import { liveQuery } from '../state/lab'
import './lab.css'

const PLACEHOLDER = 'when x > 10 and depth > 2 · changed(o.f) · calls(f) where ret < 0'
/** The most rows the list shows. */
export const MAX_QUERY_ROWS = 200

export interface QueryRow {
  /** Where activating the row puts the pen. */
  readonly time: number
  readonly text: string
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

/** "3 stretches · 41 statements", "12 changes", "25 calls". */
export function querySummary(result: QueryResult): string {
  switch (result.kind) {
    case 'when': {
      if (result.matches === 0) return 'never true'
      const more = result.truncated ? ' (more not shown)' : ''
      return `${plural(result.intervals.length, 'stretch', 'stretches')} · ${plural(result.matches, 'statement')}${more}`
    }
    case 'changed':
      return result.total === 0 ? 'never changed' : plural(result.total, 'change')
    case 'calls':
      return result.total === 0 ? 'no call matches' : plural(result.total, 'call')
  }
}

function lineText(recording: Recording, time: number): string {
  const location = recording.locationAt(Math.min(time, recording.length))
  if (location === null) return 'the end'
  return location.source === 'main' ? `line ${location.stmtLine}` : 'library'
}

function valueText(value: TracedValue): string {
  if (value === null) return 'nil'
  if (typeof value === 'object') return 'an object'
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function changeText(recording: Recording, event: ProvenanceEvent): string {
  const name = writeName(recording, event) ?? 'value'
  if (event.kind === 'list') return `${event.op ?? 'changed'} ${valueText(event.value)}`
  if (event.kind === 'delete') return `${name} deleted`
  return `${name} = ${valueText(event.value)}`
}

/** The rows of the results list, in time order (at most `MAX_QUERY_ROWS`). */
export function queryRows(recording: Recording, result: QueryResult): QueryRow[] {
  const step = (time: number) => `step ${formatCount(time)}`
  switch (result.kind) {
    case 'when':
      return result.intervals.slice(0, MAX_QUERY_ROWS).map((interval) => ({
        time: interval.from,
        text: `${step(interval.from)} to ${formatCount(interval.to)} · ${lineText(recording, interval.from)}`,
      }))
    case 'changed':
      return result.events.slice(0, MAX_QUERY_ROWS).map((event) => ({
        // Just after the write, so the panels show the new value.
        time: Math.min(event.time + 1, recording.length),
        text: `${step(event.time)} · ${lineText(recording, event.time)} · ${changeText(recording, event)}`,
      }))
    case 'calls':
      return result.calls.slice(0, MAX_QUERY_ROWS).map((call) => ({
        time: call.entry,
        text: `${step(call.entry)} · ${call.text}`,
      }))
  }
}

/** The nearest match strictly before / after `time`, or null. */
export function neighbours(
  times: readonly number[],
  time: number,
): { readonly previous: number | null; readonly next: number | null } {
  let previous: number | null = null
  let next: number | null = null
  for (const t of times) {
    if (t < time) previous = t
    else if (t > time && next === null) next = t
  }
  return { previous, next }
}

export function QueryBar() {
  const recording = useStudio((s) => s.recording)
  const time = useStudio((s) => s.time)
  const marks = useStudio((s) => liveQuery(s.lab, s.recording))
  const { setQueryMarks, seek } = useStudioActions()
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<{ recording: Recording; text: string } | null>(null)
  const [pending, setPending] = useState<{ recording: Recording; text: string } | null>(null)
  const [listed, setListed] = useState(false)
  const errorId = useId()
  const listId = useId()

  // The search runs after "Searching…" has been painted: a long run takes a moment to scan.
  useEffect(() => {
    if (pending === null) return
    const timer = setTimeout(() => {
      const outcome = queryRecording(pending.recording, pending.text, { limit: 2000 })
      setPending(null)
      if (outcome.ok) {
        setQueryMarks({ recording: pending.recording, text: pending.text, result: outcome.result })
      } else {
        setProblem({ recording: pending.recording, text: outcome.error })
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [pending, setQueryMarks])

  const times = useMemo(() => (marks ? queryTimes(marks.result) : []), [marks])
  const rows = useMemo(
    () => (marks && listed ? queryRows(marks.recording, marks.result) : []),
    [marks, listed],
  )
  const error = problem !== null && problem.recording === recording ? problem.text : null
  const searching = pending !== null && pending.recording === recording
  const { previous, next } = neighbours(times, time)

  const clear = () => {
    setText('')
    setProblem(null)
    setPending(null)
    setListed(false)
    setQueryMarks(null)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setProblem(null)
    setQueryMarks(null)
    if (recording === null || text.trim() === '') return setPending(null)
    setPending({ recording, text })
  }

  return (
    <form className="tl-query" role="search" aria-label="Query the run" onSubmit={submit}>
      <label className="tl-query__field">
        <span className="tl-chart__label">Query</span>
        <input
          className="tl-query__input"
          value={text}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          autoComplete="off"
          disabled={recording === null}
          aria-invalid={error !== null}
          aria-describedby={errorId}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            clear()
          }}
        />
      </label>
      <span className="tl-query__summary" aria-live="polite">
        {searching ? 'Searching…' : marks ? querySummary(marks.result) : ''}
      </span>
      {marks && times.length > 0 && (
        <span className="tl-query__nav">
          <button
            type="button"
            className="ch-button-small"
            disabled={previous === null}
            onClick={() => previous !== null && seek(previous)}
          >
            Previous
          </button>
          <button
            type="button"
            className="ch-button-small"
            disabled={next === null}
            onClick={() => next !== null && seek(next)}
          >
            Next
          </button>
          <button
            type="button"
            className="ch-button-small"
            aria-expanded={listed}
            aria-controls={listId}
            onClick={() => setListed(!listed)}
          >
            List
          </button>
        </span>
      )}
      <span id={errorId} className="tl-query__error" role="alert">
        {error ?? ''}
      </span>
      {marks && listed && (
        <ol id={listId} className="tl-query__list" aria-label="Query matches">
          {rows.map((row, i) => (
            <li key={i}>
              <button
                type="button"
                className="tl-query__row"
                aria-current={row.time === time ? 'step' : undefined}
                onClick={() => seek(row.time)}
              >
                {row.text}
              </button>
            </li>
          ))}
          {times.length > rows.length && (
            <li className="tl-query__more">{formatCount(times.length - rows.length)} more</li>
          )}
        </ol>
      )}
    </form>
  )
}
