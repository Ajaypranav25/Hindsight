/**
 * The bug finder's automatic answers (ARCHITECTURE §7.6, §11.3): the questions the program's
 * contracts and assertions answered, each with its evidence, the switch that turns them on, and
 * the user's own answers offered as assertions so they answer themselves next time.
 */
import { useMemo } from 'react'
import { answerAssertions, callTree, insertAssertions } from '../../core/index'
import { liveSession } from '../state/bug-finder'
import { useStudio, useStudioActions } from '../state/context'
import type { AutomaticAnswerView } from './bug-finder-model'

/** "Use contracts and assertions": whether interviews take automatic answers (restarts one). */
export function AutoToggle() {
  const auto = useStudio((s) => s.bugFinder.auto)
  const { setBugFinderAuto } = useStudioActions()
  return (
    <button
      type="button"
      className="ch-button ch-button-small bf-auto-toggle"
      aria-pressed={auto}
      title={
        auto
          ? 'Contracts (requires, ensures) and assertions answer the questions they can. Press to answer every question yourself.'
          : 'You answer every question. Press to let contracts and assertions answer what they can.'
      }
      onClick={() => setBugFinderAuto(!auto)}
    >
      Use contracts and assertions
    </button>
  )
}

/**
 * The answers contracts and assertions gave so far, below the question or verdict (which stay in
 * view); the list folds away. Undo takes the last one back.
 */
export function AutomaticAnswers(props: { readonly answers: readonly AutomaticAnswerView[] }) {
  const { answers } = props
  if (answers.length === 0) return null
  const count = answers.length === 1 ? '1 question' : `${answers.length} questions`
  return (
    <details className="bf-auto" open aria-label="Answered by your contracts and assertions">
      <summary className="pn-note bf-auto-title">
        Answered by your contracts and assertions ({count})
      </summary>
      <ol className="bf-auto-list">
        {answers.map((entry) => (
          <li key={entry.id} className="bf-auto-item" data-answer={entry.answer}>
            <span className="bf-auto-number">Q{entry.number}</span>{' '}
            <code className="bf-auto-call">{entry.text}</code>{' '}
            <span className="bf-auto-answer">— {entry.answer}</span>{' '}
            <span className="bf-auto-reason">({entry.reason})</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

/**
 * Under a verdict: the calls the user judged right, as `assert(f(args) == result)` lines, with
 * "Add to the program" (after the last top-level function; the next run lets them answer).
 */
export function AnswerAssertions() {
  const recording = useStudio((s) => s.recording)
  const bugFinder = useStudio((s) => s.bugFinder)
  const source = useStudio((s) => s.source)
  const { setSource } = useStudioActions()
  const session = liveSession(bugFinder, recording)
  const texts = useMemo(
    () =>
      session === null
        ? []
        : answerAssertions(callTree(session.recording), session.finder).map((entry) => entry.text),
    [session],
  )
  if (texts.length === 0) return null
  const added = texts.every((text) => source.includes(text))
  return (
    <section className="bf-asserts" aria-label="Your answers as assertions">
      <p className="pn-note bf-auto-title">
        Your answers as assertions: added to the program, these questions answer themselves next
        time.
      </p>
      <pre className="bf-assert-code">{texts.join('\n')}</pre>
      <div className="bf-row">
        <button
          type="button"
          className="ch-button ch-button-small"
          disabled={added}
          onClick={() => setSource(insertAssertions(source, texts))}
        >
          {added ? 'Added to the program' : 'Add to the program'}
        </button>
      </div>
    </section>
  )
}
