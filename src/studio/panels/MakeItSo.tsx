import { type FormEvent, useEffect, useRef, useState } from 'react'
import {
  type InverseGoal,
  type InverseResult,
  type InverseSolution,
  type Recording,
  solveInverseAsync,
} from '../../core/index'
import { formatCount } from '../lib/format'
import { useStudioActions } from '../state/context'
import { useAsyncSearch } from '../state/use-search'
import './make-it-so.css'

/** A goal the user set for a recording: the inverse what-if searches for a past that reaches it. */
export interface Wish {
  readonly recording: Recording
  readonly goal: InverseGoal
  /** What is wanted, for the heading: `line 3 to print "100"`. */
  readonly label: string
}

/**
 * The inline form under an output line: the wanted text, prefilled with what the line reads now.
 * Enter starts the search; Escape closes the form.
 */
export function WishForm(props: {
  readonly current: string
  readonly onWish: (text: string) => void
  readonly onCancel: () => void
}) {
  const { current, onWish, onCancel } = props
  const [text, setText] = useState(current)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (text.trim() !== '' && text.trim() !== current.trim()) onWish(text)
  }
  return (
    <form
      className="pn-wish"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <label className="pn-wish-label">
        <span className="pn-note">Make this line print</span>
        <input
          ref={input}
          className="pn-wish-input"
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button type="submit" className="ch-button ch-button-small">
        Find how
      </button>
      <button type="button" className="ch-button ch-button-small" onClick={onCancel}>
        Cancel
      </button>
    </form>
  )
}

/**
 * The inverse what-if's answers (ARCHITECTURE §7.11, §11.3): sentences naming an earlier value
 * that reaches the goal, each with "Try it", which forks the run with that value.
 */
export function WishResults(props: { readonly wish: Wish; readonly onClose: () => void }) {
  const { wish, onClose } = props
  const search = useAsyncSearch<InverseResult>(wish, (signal) =>
    solveInverseAsync(wish.recording, wish.goal, { signal }),
  )
  const { seek, forkWhatIf } = useStudioActions()
  const tryIt = (solution: InverseSolution) => {
    const { candidate, value } = solution
    seek(candidate.time)
    void forkWhatIf(candidate.target, value, candidate.name)
  }
  return (
    <section className="pn-wishes" aria-label="Make it so">
      <header className="pn-wishes-head">
        <h3 className="pn-label">To get {wish.label}</h3>
        <button type="button" className="ch-button ch-button-small" onClick={onClose}>
          {search.status === 'done' ? 'Close' : 'Stop'}
        </button>
      </header>
      <div aria-live="polite">
        {search.status === 'done' ? (
          <Answers result={search.result} onTry={tryIt} />
        ) : (
          <p className="pn-note">Searching the past for a value that does it…</p>
        )}
      </div>
    </section>
  )
}

function Answers(props: {
  readonly result: InverseResult
  readonly onTry: (solution: InverseSolution) => void
}) {
  const { result, onTry } = props
  if (result.problem !== null) return <p className="pn-note">{result.problem}</p>
  const effort = `${formatCount(result.candidates)} earlier ${result.candidates === 1 ? 'value' : 'values'} tried in ${formatCount(result.forks)} what-if ${result.forks === 1 ? 'run' : 'runs'}`
  if (result.solutions.length === 0) {
    return (
      <p className="pn-note">
        No single earlier value reaches that
        {result.exhausted ? ' within the search budget' : ''} ({effort}).
      </p>
    )
  }
  return (
    <>
      <ul className="pn-wish-list">
        {result.solutions.map((solution) => (
          <li key={solution.sentence} className="pn-wish-answer">
            <span>{solution.sentence}</span>
            <button
              type="button"
              className="ch-button ch-button-small"
              onClick={() => onTry(solution)}
            >
              Try it
            </button>
          </li>
        ))}
      </ul>
      <p className="pn-note">{effort}.</p>
    </>
  )
}
