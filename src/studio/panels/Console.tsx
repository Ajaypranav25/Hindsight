import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Diagnostic,
  OutputEvent,
  Recording,
  RecordingComparison,
  UnfinishedTask,
} from '../../core/index'
import { LineIndex, taskWaitText } from '../../core/index'
import type { MenuAnchor } from '../chrome/ContextMenu'
import { copyText, selectText } from '../lib/clipboard'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import { type LineActions, OutputLine } from './ConsoleLine'
import { type Wish, WishResults } from './MakeItSo'
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
  const { seek, sliceFrom } = useStudioActions()
  const comparison = useStudio((s) => s.whatIf?.comparison ?? null)
  const changed = useMemo(() => changedLines(comparison), [comparison])
  const outputs = recording.outputs
  const { start, end, printed } = consoleWindow(outputs, time)
  const listRef = useLastPrintedInView(printed)
  const visible = outputs.slice(start, end)
  // What the user asked the past for; it belongs to the recording it was asked about.
  const [asked, setAsked] = useState<Wish | null>(null)
  const [wishing, setWishing] = useState<LineMark | null>(null)
  const [menu, setMenu] = useState<(LineMark & { readonly anchor: MenuAnchor }) | null>(null)
  const [copied, setCopied] = useState<(LineMark & { readonly ok: boolean }) | null>(null)
  const wish = asked?.recording === recording ? asked : null
  const formAt = wishing?.recording === recording ? wishing.index : null
  const menuAt = menu?.recording === recording ? menu : null
  const copiedNow = copied?.recording === recording ? copied : null
  const makeWish = (index: number, text: string) => {
    setWishing(null)
    setAsked({
      recording,
      goal: { kind: 'output', index, text },
      label: `output line ${formatCount(index + 1)} to read ${JSON.stringify(text.trim())}`,
    })
  }
  const lineActions = (index: number, event: OutputEvent): LineActions => ({
    seek,
    setWishing: (open) => setWishing(open ? { recording, index } : null),
    wish: (text) => makeWish(index, text),
    slice: () => {
      seek(event.time)
      sliceFrom(event.time, `output line ${formatCount(index + 1)}`)
    },
    setMenu: (anchor) => {
      setCopied(null)
      setMenu(anchor === null ? null : { recording, index, anchor })
    },
    copy: (node) => {
      void copyText(event.text).then((ok) => {
        if (!ok && node !== null) selectText(node)
        setCopied({ recording, index, ok })
      })
    },
  })
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
              index={start + i}
              time={time}
              lastPrinted={start + i === printed - 1}
              changed={changed?.has(start + i) ?? false}
              wishing={formAt === start + i}
              menu={menuAt !== null && menuAt.index === start + i ? menuAt.anchor : null}
              actions={lineActions(start + i, event)}
            />
          ))}
        </ol>
      )}
      {end < outputs.length && (
        <p className="pn-note pn-pad">{formatCount(outputs.length - end)} later lines not shown</p>
      )}
      <p className="pn-note pn-pad pn-copied" role="status">
        {copiedNow === null ? '' : copiedText(copiedNow.index, copiedNow.ok)}
      </p>
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

/** A console line of one recording. */
interface LineMark {
  readonly recording: Recording
  readonly index: number
}

/** What "Copy line" did. */
export function copiedText(index: number, ok: boolean): string {
  const line = `Output line ${formatCount(index + 1)}`
  return ok ? `${line} copied` : `${line} is selected: press Ctrl+C or ⌘ C to copy it`
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
  if (outcome.kind === 'finished') return <UnfinishedTasks tasks={outcome.unfinishedTasks} />
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
      {error.code === DEADLOCK && error.hint ? (
        <ul className="pn-deadlock" aria-label="What each task waits for">
          {error.hint.split('; ').map((wait) => (
            <li key={wait}>{wait}</li>
          ))}
        </ul>
      ) : (
        error.hint && <p className="pn-hint">{error.hint}</p>
      )}
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
/** The deadlock error (SPEC §10.6): its hint lists every waiting task, one per `; `. */
const DEADLOCK = 'R028'

/** The tasks a finished run left waiting or ready when its main task ended (SPEC §10.6). */
function UnfinishedTasks(props: { readonly tasks: readonly UnfinishedTask[] | undefined }) {
  const { tasks } = props
  if (tasks === undefined || tasks.length === 0) return null
  const names = (id: number) => tasks.find((task) => task.id === id)?.name
  return (
    <div className="pn-note pn-pad" role="note">
      The main task ended while {tasks.length === 1 ? '1 task was' : `${tasks.length} tasks were`}{' '}
      unfinished:
      <ul className="pn-deadlock">
        {tasks.map((task) => (
          <li key={task.id}>
            task {task.id} ({task.name}) {taskWaitText(task.wait, names)}
          </li>
        ))}
      </ul>
    </div>
  )
}

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
