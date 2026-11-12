import { useEffect, useMemo, useRef, useState } from 'react'
import type { Diagnostic, OutputEvent, Recording, RecordingComparison } from '../../core/index'
import { LineIndex } from '../../core/index'
import { clipText, formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import { type Wish, WishForm, WishResults } from './MakeItSo'
import { consoleWindow } from './panel-logic'
import { RepairPreviews } from './RepairPreviews'
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
  const comparison = useStudio((s) => s.whatIf?.comparison ?? null)
  const changed = useMemo(() => changedLines(comparison), [comparison])
  const outputs = recording.outputs
  const { start, end, printed } = consoleWindow(outputs, time)
  const listRef = useLastPrintedInView(printed)
  const visible = outputs.slice(start, end)
  // What the user asked the past for; it belongs to the recording it was asked about.
  const [asked, setAsked] = useState<Wish | null>(null)
  const [wishing, setWishing] = useState<{ recording: Recording; index: number } | null>(null)
  const wish = asked?.recording === recording ? asked : null
  const formAt = wishing?.recording === recording ? wishing.index : null
  const makeWish = (index: number, text: string) => {
    setWishing(null)
    setAsked({
      recording,
      goal: { kind: 'output', index, text },
      label: `output line ${formatCount(index + 1)} to read ${JSON.stringify(text.trim())}`,
    })
  }
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
              changed={changed?.has(start + i) ?? false}
              onSeek={seek}
              wishing={formAt === start + i}
              onWishing={(open) => setWishing(open ? { recording, index: start + i } : null)}
              onWish={(text) => makeWish(start + i, text)}
            />
          ))}
        </ol>
      )}
      {end < outputs.length && (
        <p className="pn-note pn-pad">{formatCount(outputs.length - end)} later lines not shown</p>
      )}
      {comparison !== null && comparison.removed > 0 && (
        <p className="pn-note pn-pad">
          {formatCount(comparison.removed)} {comparison.removed === 1 ? 'line' : 'lines'} of the
          real run {comparison.removed === 1 ? 'is' : 'are'} not printed in this what-if
        </p>
      )}
      <RunEnd
        recording={recording}
        time={time}
        onSeek={seek}
        onAvoid={() =>
          setAsked({ recording, goal: { kind: 'no-error' }, label: 'this error not to happen' })
        }
      />
      {wish && <WishResults wish={wish} onClose={() => setAsked(null)} />}
    </>
  )
}

function OutputLine(props: {
  readonly event: OutputEvent
  readonly time: number
  readonly lastPrinted: boolean
  /** Not printed by the real run (in what-if mode). */
  readonly changed: boolean
  readonly onSeek: (time: number) => void
  /** The "make this print" form is open under this line. */
  readonly wishing: boolean
  readonly onWishing: (open: boolean) => void
  readonly onWish: (text: string) => void
}) {
  const { event, time, lastPrinted, changed, onSeek, wishing, onWishing, onWish } = props
  const wishButton = useRef<HTMLButtonElement>(null)
  const closeForm = () => {
    onWishing(false)
    wishButton.current?.focus()
  }
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
        {changed && (
          <span className="pn-badge pn-badge--whatif" title="The real run did not print this line">
            changed
          </span>
        )}
      </button>
      <button
        ref={wishButton}
        type="button"
        className="pn-line-wish"
        aria-expanded={wishing}
        title="Find an earlier value that makes this line print something else"
        onClick={() => onWishing(!wishing)}
      >
        Make this print…
      </button>
      {wishing && <WishForm current={event.text} onWish={onWish} onCancel={closeForm} />}
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
  /** Asks the past for a value that avoids the error. */
  readonly onAvoid: () => void
}) {
  const { recording, time, onSeek, onAvoid } = props
  const [fixing, setFixing] = useState<Recording | null>(null)
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
      <div className="pn-failure-tools">
        <button type="button" className="ch-button ch-button-small" onClick={onAvoid}>
          Make this not happen
        </button>
        <button
          type="button"
          className="ch-button ch-button-small"
          aria-expanded={fixing === recording}
          onClick={() => setFixing(fixing === recording ? null : recording)}
        >
          Try one-token fixes
        </button>
      </div>
      {fixing === recording && <CrashFixes recording={recording} />}
    </div>
  )
}

const CRASH_REQUEST = { kind: 'crash' } as const

/** One-token changes to the function the run crashed in that make the run finish. */
function CrashFixes(props: { readonly recording: Recording }) {
  return (
    <RepairPreviews
      recording={props.recording}
      request={CRASH_REQUEST}
      basis="the run finishing without an error"
      whenNone="No one-token change makes the run finish."
    />
  )
}

/** Indexes of the what-if's output lines that the real run did not print. */
function changedLines(comparison: RecordingComparison | null): ReadonlySet<number> | null {
  if (comparison === null) return null
  const indexes = new Set<number>()
  for (const line of comparison.lines) {
    if (line.kind === 'added' && line.indexB !== null) indexes.add(line.indexB)
  }
  return indexes
}
