/**
 * The bug finder's automatic answers (ARCHITECTURE §7.6, §11.3): the questions the program's
 * contracts and assertions answered, each with its evidence, and the switch that turns them on.
 */
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

/** The answers contracts and assertions gave so far; Undo takes the last one back. */
export function AutomaticAnswers(props: { readonly answers: readonly AutomaticAnswerView[] }) {
  const { answers } = props
  if (answers.length === 0) return null
  return (
    <section className="bf-auto" aria-label="Answered by your contracts and assertions">
      <p className="pn-note bf-auto-title">Answered by your contracts and assertions</p>
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
    </section>
  )
}
