/**
 * "Suggest contracts" (ARCHITECTURE §11.3): likely `requires`/`ensures` clauses for one function,
 * inferred from its recorded calls by the analysis service (a worker where there is one) and
 * checked by recording the program with them. Opened from the editor (a chip while the cursor is on
 * a `fn` line) or from the call stack; "Add to the function" writes the chosen clauses into the
 * function's header. Inferred on a version you trust, they let the bug finder answer its own
 * questions on a later, broken one.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  type ContractSuggestion,
  type FrameView,
  type InferResult,
  withContracts,
} from '../../core/index'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import {
  contractsFor,
  contractsSummary,
  type ContractsTarget,
  functionAtLine,
  functionOfProto,
  supportText,
} from './contracts-model'
import {
  closeContracts,
  openContracts,
  useContractsTarget,
  useEditorCursorLine,
} from './contracts-state'
import { useInsight } from './use-insight'
import './insight.css'

/** True while the shown run is a real run of the editor's program. */
function useFreshRun(): boolean {
  return useStudio(
    (s) => s.recording !== null && s.recordedSource === s.source && s.whatIf === null,
  )
}

/** The card for the function it is open for, else the chip offering one for the cursor's `fn`. */
export function ContractsCard() {
  const target = useContractsTarget()
  const recording = useStudio((s) => s.recording)
  if (target !== null && target.recording === recording) return <SuggestionsCard target={target} />
  return <SuggestChip />
}

function SuggestChip() {
  const line = useEditorCursorLine()
  const recording = useStudio((s) => s.recording)
  const fresh = useFreshRun()
  const target = useMemo(
    () => (recording !== null && fresh && line !== null ? functionAtLine(recording, line) : null),
    [recording, fresh, line],
  )
  if (target === null) return null
  return (
    <button
      type="button"
      className="ch-button ch-button-small in-suggest"
      title="Clauses that held in every recorded call of this function"
      onClick={() => openContracts(target)}
    >
      Suggest contracts for {target.name}
    </button>
  )
}

/** A small button on the selected call stack frame that opens the card for its function. */
export function ContractsFrameButton(props: { readonly frame: FrameView }) {
  const recording = useStudio((s) => s.recording)
  const fresh = useFreshRun()
  const { frame } = props
  const target = useMemo(
    () =>
      recording !== null && fresh && !frame.library
        ? functionOfProto(recording, frame.protoId)
        : null,
    [recording, fresh, frame],
  )
  if (target === null) return null
  return (
    <button
      type="button"
      className="in-frame-contracts"
      aria-label={`Suggest contracts for ${target.name}`}
      title={`Suggest contracts for ${target.name}`}
      onClick={() => openContracts(target)}
    >
      Contracts
    </button>
  )
}

const keyOf = (suggestion: ContractSuggestion) => `${suggestion.kind} ${suggestion.clause}`

function SuggestionsCard(props: { readonly target: ContractsTarget }) {
  const { target } = props
  const request = useMemo(() => ({ kind: 'infer' as const, fn: target.name }), [target.name])
  const state = useInsight(target.recording, request)
  const cardRef = useRef<HTMLElement>(null)
  useEffect(() => cardRef.current?.focus(), [target])
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    closeContracts()
  }
  return (
    <section
      ref={cardRef}
      className="in-contracts"
      aria-label={`Contracts for ${target.name}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="in-contracts-head">
        <span className="in-contracts-title">
          Contracts for <code>{target.name}</code>
        </span>
        <button
          type="button"
          className="ch-button ch-button-small"
          aria-label="Close the contract suggestions"
          onClick={closeContracts}
        >
          Close
        </button>
      </div>
      {state.status === 'failed' && (
        <p className="in-contracts-text">The contracts could not be inferred: {state.error}</p>
      )}
      {(state.status === 'working' || state.status === 'idle') && (
        <p className="in-contracts-text" aria-live="polite">
          Reading the recorded calls of {target.name} and checking clauses…
        </p>
      )}
      {state.status === 'done' && (
        <Suggestions target={target} result={state.value.result} key={target.functionStart} />
      )}
    </section>
  )
}

function Suggestions(props: { readonly target: ContractsTarget; readonly result: InferResult }) {
  const { target, result } = props
  const found = contractsFor(result, target)
  const suggestions = found?.suggestions ?? []
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set())
  const source = useStudio((s) => s.source)
  const fresh = useStudio((s) => s.recordedSource === s.source)
  const { setSource, seek } = useStudioActions()
  const chosen = suggestions.filter((s) => !unchecked.has(keyOf(s)))
  const toggle = (key: string) =>
    setUnchecked((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const add = () => {
    setSource(withContracts(source, [{ functionStart: target.functionStart, suggestions: chosen }]))
    closeContracts()
  }
  return (
    <>
      <p className="in-contracts-text" aria-live="polite">
        {contractsSummary(found, result)}
      </p>
      {suggestions.length > 0 && (
        <ul className="in-clauses" aria-label="Suggested clauses">
          {suggestions.map((suggestion) => (
            <li key={keyOf(suggestion)} className="in-clause">
              <label className="in-clause-label">
                <input
                  type="checkbox"
                  checked={!unchecked.has(keyOf(suggestion))}
                  onChange={() => toggle(keyOf(suggestion))}
                />
                <code className="in-clause-code">
                  <span className="in-clause-kind">{suggestion.kind}</span> {suggestion.clause}
                </code>
              </label>
              <span className="in-clause-note">
                {supportText(suggestion)}
                {suggestion.pins ? ' · pins the result down' : ''} ·{' '}
                <button
                  type="button"
                  className="in-link"
                  title="Go to this call"
                  onClick={() => seek(suggestion.example.entry)}
                >
                  {suggestion.example.text}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {result.withdrawn > 0 && (
        <p className="in-contracts-note">
          {formatCount(result.withdrawn)}{' '}
          {result.withdrawn === 1 ? 'clause failed' : 'clauses failed'} the check run and{' '}
          {result.withdrawn === 1 ? 'was' : 'were'} left out.
        </p>
      )}
      {result.problem !== null && <p className="in-contracts-note">{result.problem}</p>}
      {suggestions.length > 0 && (
        <div className="in-contracts-actions">
          <button
            type="button"
            className="ch-button ch-button-small"
            disabled={chosen.length === 0 || !fresh}
            onClick={add}
          >
            Add to the function
          </button>
          <span className="in-contracts-note">
            Added to a version you trust, they let the bug finder answer its own questions on the
            next one.
          </span>
        </div>
      )}
    </>
  )
}
