import { useEffect, useMemo, useRef } from 'react'
import type { Diagnostic, OutputEvent, Recording } from '../../core/index'
import { LineIndex } from '../../core/index'
import { clipText, formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import { consoleWindow } from './panel-logic'
import './panels.css'

/** Program output at the pen: printed lines, future lines ghosted, and how the run ended. */
export function Console() {
  const recording = useStudio((s) => s.recording)
  const compile = useStudio((s) => s.compile)
  const source = useStudio((s) => s.source)
  const diagnostics = compile && !compile.ok ? compile.diagnostics : null
  return (
    <div className="pn-console">
      {diagnostics && <CompileErrors diagnostics={diagnostics} source={source} />}
      {recording ? (
        <Output recording={recording} />
      ) : (
        !diagnostics && <p className="pn-empty">Run the program to see its output</p>
      )}
    </div>
  )
}

function CompileErrors(props: {
  readonly diagnostics: readonly Diagnostic[]
  readonly source: string
}) {
  const lines = useMemo(() => new LineIndex(props.source), [props.source])
  return (
    <section className="pn-compile" aria-labelledby="pn-compile-title">
      <h3 className="pn-label" id="pn-compile-title">
        Does not compile
      </h3>
      <ul className="pn-diagnostics">
        {props.diagnostics.map((d, i) => (
          <li key={i} className="pn-diagnostic">
            <span className="pn-stamp">line {lines.lineOf(d.span.start)}</span>
            <span>
              <span className="pn-code">{d.code}</span> {d.message}
              {d.hint && <span className="pn-hint">{d.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Output(props: { readonly recording: Recording }) {
  const { recording } = props
  const time = useStudio((s) => s.time)
  const { seek } = useStudioActions()
  const outputs = recording.outputs
  const { start, end, printed } = consoleWindow(outputs, time)
  const listRef = useLastPrintedInView(printed)
  const visible = outputs.slice(start, end)
  return (
    <>
      {outputs.length === 0 && <p className="pn-empty">Nothing printed</p>}
      {start > 0 && <p className="pn-note pn-pad">{formatCount(start)} earlier lines not shown</p>}
      {visible.length > 0 && (
        <ol className="pn-lines" aria-label="Program output" ref={listRef}>
          {visible.map((event, i) => (
            <OutputLine
              key={start + i}
              event={event}
              time={time}
              lastPrinted={start + i === printed - 1}
              onSeek={seek}
            />
          ))}
        </ol>
      )}
      {end < outputs.length && (
        <p className="pn-note pn-pad">{formatCount(outputs.length - end)} later lines not shown</p>
      )}
      <RunEnd recording={recording} time={time} onSeek={seek} />
    </>
  )
}

function OutputLine(props: {
  readonly event: OutputEvent
  readonly time: number
  readonly lastPrinted: boolean
  readonly onSeek: (time: number) => void
}) {
  const { event, time, lastPrinted, onSeek } = props
  const atPen = event.time === time
  const future = event.time >= time
  const className = `pn-line${future ? ' pn-line--future' : ''}${atPen ? ' pn-line--now' : ''}`
  return (
    <li className={className} data-last-printed={lastPrinted ? 'true' : undefined}>
      <button
        type="button"
        className="pn-line-btn"
        aria-current={atPen ? 'step' : undefined}
        title={`Printed at step ${formatCount(event.time)}${future ? ' (after the pen)' : ''}`}
        onClick={() => onSeek(event.time)}
      >
        <span className="pn-stamp">{formatCount(event.time)}</span>
        <span className="pn-out">{clipText(event.text)}</span>
      </button>
    </li>
  )
}

/** Scrolls the latest printed line into view whenever the pen moves forward past new output. */
function useLastPrintedInView(printed: number) {
  const listRef = useRef<HTMLOListElement>(null)
  const previous = useRef(printed)
  useEffect(() => {
    const movedForward = printed > previous.current
    previous.current = printed
    if (!movedForward) return
    const line = listRef.current?.querySelector('[data-last-printed]')
    if (line && typeof line.scrollIntoView === 'function') line.scrollIntoView({ block: 'nearest' })
  }, [printed])
  return listRef
}

function RunEnd(props: {
  readonly recording: Recording
  readonly time: number
  readonly onSeek: (t: number) => void
}) {
  const { recording, time, onSeek } = props
  const outcome = recording.outcome
  const atEnd = time === recording.length
  if (outcome.kind === 'step-limit') {
    return (
      <p className="pn-note pn-pad">
        Stopped at the step limit ({formatCount(outcome.maxSteps)} steps)
      </p>
    )
  }
  if (outcome.kind === 'aborted')
    return <p className="pn-note pn-pad">Recording stopped before the program ended</p>
  if (outcome.kind !== 'error') return null
  const { error } = outcome
  return (
    <div
      className={`pn-failure${atEnd ? '' : ' pn-failure--future'}`}
      role="group"
      aria-label="Runtime error"
    >
      <p className="pn-failure-msg">
        <span className="pn-code">{error.code}</span> {error.message}
      </p>
      {error.hint && <p className="pn-hint">{error.hint}</p>}
      {!atEnd && (
        <button type="button" className="pn-link" onClick={() => onSeek(recording.length)}>
          Jump to the failure
        </button>
      )}
    </div>
  )
}
