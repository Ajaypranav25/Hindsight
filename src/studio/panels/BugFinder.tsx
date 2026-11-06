import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type RefObject } from 'react'
import {
  type Answer,
  callSignature,
  changeTexts,
  type CallDetails,
  linesText,
  type Recording,
} from '../../core/index'
import { liveSession } from '../state/bug-finder'
import { useStudio, useStudioActions } from '../state/context'
import {
  afterCallTime,
  announcement,
  callAtPen,
  finderView,
  type FinderView,
  runError,
} from './bug-finder-model'
import './bug-finder.css'

/** Keys that answer while focus is inside the question (no modifiers, not while typing). */
const ANSWER_KEYS: Readonly<Record<string, Answer>> = { r: 'right', w: 'wrong', n: 'unsure' }

/**
 * The bug finder (ARCHITECTURE §7.6, §11.3): yes/no questions about recorded calls that narrow a
 * wrong result down to one function. Not modal: the pen, the editor and every other panel stay
 * usable while the user answers.
 */
export function BugFinder() {
  const recording = useStudio((s) => s.recording)
  const bugFinder = useStudio((s) => s.bugFinder)
  const session = liveSession(bugFinder, recording)
  const view = useMemo(() => (session ? finderView(session) : null), [session])
  const container = useRef<HTMLDivElement>(null)
  useFocusOnChange(container, view?.kind ?? 'intro', bugFinder.reveal)

  if (!recording) {
    return <p className="pn-empty">Run the program, then let Hindsight find the bug.</p>
  }
  return (
    <div className="bf" ref={container}>
      {view ? <Interview view={view} /> : <Intro recording={recording} />}
      <p className="bf-live" role="status" aria-live="polite">
        {announcement(view)}
      </p>
    </div>
  )
}

/**
 * Focuses the panel's heading when the panel is revealed, and when the focused button went away
 * with the view it belonged to (answering the last question, undoing a verdict). Focus elsewhere
 * (the editor, the timeline) is never taken.
 */
function useFocusOnChange(
  container: RefObject<HTMLDivElement | null>,
  kind: string,
  reveal: number,
): void {
  const revealed = useRef(reveal)
  useEffect(() => {
    if (revealed.current === reveal) return
    revealed.current = reveal
    headingIn(container.current)?.focus()
  }, [reveal, container])
  useEffect(() => {
    const active = document.activeElement
    if (active === null || active === document.body) headingIn(container.current)?.focus()
  }, [kind, container])
}

function headingIn(element: HTMLElement | null): HTMLElement | null {
  return element?.querySelector<HTMLElement>('.bf-heading') ?? null
}

function Intro(props: { recording: Recording }) {
  const { recording } = props
  const time = useStudio((s) => s.time)
  const justMyCode = useStudio((s) => s.settings.justMyCode)
  const { startBugFinder, seek } = useStudioActions()
  const error = runError(recording)
  const penCall = useMemo(
    () => callAtPen(recording, time, justMyCode),
    [recording, time, justMyCode],
  )
  const id = useId()
  return (
    <section className="bf-intro" aria-labelledby={id}>
      <h3 id={id} className="pn-label bf-heading" tabIndex={-1}>
        Find the bug
      </h3>
      <p className="bf-text">
        Answer a few questions about the calls your program made, and Hindsight narrows a wrong
        result down to the one function whose own code is wrong.
      </p>
      {error ? (
        <div className="bf-error" role="note">
          <p className="bf-text">
            This run ended with a runtime error on line {error.line}: {error.message}. The bug
            finder is for wrong results, so start with the error.
          </p>
          <div className="bf-row">
            <button type="button" className="ch-button" onClick={() => seek(recording.length)}>
              Go to the error
            </button>
            <button
              type="button"
              className="ch-button ch-button-small"
              onClick={() => startBugFinder()}
            >
              Find the bug anyway
            </button>
          </div>
        </div>
      ) : (
        <div className="bf-row">
          <button type="button" className="ch-button bf-start" onClick={() => startBugFinder()}>
            Find the bug
          </button>
        </div>
      )}
      {penCall && (
        <p className="pn-note bf-from">
          Already know a call went wrong?{' '}
          <button type="button" className="pn-link" onClick={() => startBugFinder(penCall.id)}>
            Start from the {penCall.name} call at the pen
          </button>
        </p>
      )}
    </section>
  )
}

function Interview(props: { view: FinderView }) {
  const { view } = props
  const { answerBugFinder, undoBugFinder, startBugFinder, closeBugFinder, seek } =
    useStudioActions()
  const start = useStudio((s) => s.bugFinder.session?.finder.start ?? null)
  const asked = useStudio((s) => s.bugFinder.session?.finder.asked ?? 0)
  const call = view.details.call
  const id = useId()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const key = event.key.toLowerCase()
    const given = view.kind === 'question' ? ANSWER_KEYS[key] : undefined
    if (given) answerBugFinder(given)
    else if (key === 'u') undoBugFinder()
    else return
    event.preventDefault()
  }
  return (
    <section className="bf-card" data-kind={view.kind} onKeyDown={onKeyDown} aria-labelledby={id}>
      <header className="bf-head">
        <h3 id={id} className="pn-label bf-heading" tabIndex={-1}>
          {view.kind === 'question' ? `Question ${view.number}` : 'Verdict'}
        </h3>
        <button
          type="button"
          className="pn-icon-btn"
          aria-label="Close the bug finder"
          title="Close the bug finder"
          onClick={closeBugFinder}
        >
          ×
        </button>
      </header>
      {view.kind === 'question' ? (
        <Question view={view} onAnswer={answerBugFinder} />
      ) : (
        <VerdictBody view={view} />
      )}
      <div className="bf-row bf-tools">
        {view.kind === 'question' ? (
          <button
            type="button"
            className="ch-button ch-button-small"
            onClick={() => seek(afterCallTime(call))}
          >
            Show me
          </button>
        ) : (
          <button
            type="button"
            className="ch-button ch-button-small"
            onClick={() => seek(call.entry)}
          >
            Go to the call
          </button>
        )}
        <button
          type="button"
          className="ch-button ch-button-small"
          aria-keyshortcuts="U"
          disabled={asked === 0}
          onClick={undoBugFinder}
        >
          Undo
        </button>
        <button
          type="button"
          className="ch-button ch-button-small"
          onClick={() => startBugFinder(start?.id)}
        >
          Start over
        </button>
      </div>
    </section>
  )
}

function Question(props: {
  view: FinderView & { kind: 'question' }
  onAnswer: (given: Answer) => void
}) {
  const { view, onAnswer } = props
  const { details } = view
  return (
    <>
      <CallLine details={details} />
      <p className="bf-ask">Is that right?</p>
      <div className="bf-row bf-answers" role="group" aria-label="Your answer">
        <button
          type="button"
          className="ch-button bf-answer"
          data-answer="right"
          aria-keyshortcuts="R"
          onClick={() => onAnswer('right')}
        >
          Right
        </button>
        <button
          type="button"
          className="ch-button bf-answer"
          data-answer="wrong"
          aria-keyshortcuts="W"
          onClick={() => onAnswer('wrong')}
        >
          Wrong
        </button>
        <button
          type="button"
          className="ch-button bf-answer"
          data-answer="unsure"
          aria-keyshortcuts="N"
          onClick={() => onAnswer('unsure')}
        >
          Not sure
        </button>
      </div>
      {view.remembered > 0 && (
        <p className="pn-note">
          {view.remembered === 1
            ? '1 answer was carried over from an identical call.'
            : `${view.remembered} answers were carried over from identical calls.`}
        </p>
      )}
    </>
  )
}

function VerdictBody(props: { view: FinderView & { kind: 'verdict' } }) {
  const { view } = props
  return (
    <>
      <p className="bf-found" data-certainty={view.certainty}>
        {view.headline}
      </p>
      <p className="bf-text">{view.reason}</p>
      {view.details.call.depth > 0 && <CallLine details={view.details} />}
    </>
  )
}

/** `average(xs = [88, 83, 79])` · lines 8–10 · returned `125` (and changed arguments). */
function CallLine(props: { details: CallDetails }) {
  const { details } = props
  const { call } = details
  return (
    <div className="bf-call">
      <p className="bf-signature">
        <code>{callSignature(details)}</code>
        {details.lines && <span className="pn-note"> · {linesText(details.lines)}</span>}
      </p>
      <p className="bf-outcome" data-outcome={call.outcome}>
        {call.outcome === 'returned' && (
          <>
            returned <code className="bf-value">{details.result?.text ?? 'nothing'}</code>
          </>
        )}
        {call.outcome === 'raised' &&
          `raised an error: ${details.error?.message ?? 'unknown'} (${details.error?.code ?? '?'})`}
        {call.outcome === 'unfinished' && 'was still running when the recording stopped'}
      </p>
      {changeTexts(details).map((change) => (
        <p key={change} className="bf-outcome">
          <code>{change}</code>
        </p>
      ))}
    </div>
  )
}
