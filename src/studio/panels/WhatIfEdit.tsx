/**
 * The "what if" affordance of a primitive value (ARCHITECTURE §11.3): a button beside the value
 * and an inline editor. Committing forks the run at the pen with the new value.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { ValueView, WriteTarget } from '../../core/index'
import { formatLiteral, parseLiteralValue } from '../../core/index'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'

/** The literal a value edit starts from (empty for objects, which cannot be edited). */
export function literalText(value: ValueView): string {
  switch (value.kind) {
    case 'nil':
      return 'nil'
    case 'ref':
      return ''
    default:
      return formatLiteral(value.value)
  }
}

/** True when a what-if can start: a recording is shown, nothing records, the pen is before N. */
export function useCanWhatIf(): boolean {
  return useStudio(
    (s) => s.recording !== null && s.status.kind !== 'recording' && s.time < s.recording.length,
  )
}

/** A small button that starts editing a value. */
export function WhatIfButton(props: { readonly label: string; readonly onClick: () => void }) {
  const time = useStudio((s) => s.time)
  const text = `What if ${props.label} were different at step ${formatCount(time)}?`
  return (
    <button
      type="button"
      className="pn-act pn-act--word"
      aria-label={text}
      title={text}
      onClick={props.onClick}
    >
      what if
    </button>
  )
}

/** The inline editor: Enter replays the future with the new value; Escape or leaving cancels. */
export function WhatIfInput(props: {
  readonly value: ValueView
  readonly target: WriteTarget
  readonly label: string
  readonly onDone: () => void
}) {
  const { value, target, label, onDone } = props
  const { forkWhatIf } = useStudioActions()
  const [text, setText] = useState(() => literalText(value))
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const commit = () => {
    const parsed = parseLiteralValue(text)
    if (!parsed.ok) return setError(parsed.error)
    onDone()
    void forkWhatIf(target, parsed.value, label)
  }
  return (
    <span className="pn-whatif">
      <input
        ref={inputRef}
        className="pn-whatif-input"
        value={text}
        spellCheck={false}
        autoComplete="off"
        aria-label={`What if ${label} were (Enter replays from here, Escape cancels)`}
        aria-invalid={error !== null}
        aria-describedby={errorId}
        onChange={(event) => {
          setText(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onDone()
          }
        }}
        onBlur={onDone}
      />
      <span id={errorId} className="pn-whatif-error" aria-live="polite">
        {error ?? ''}
      </span>
    </span>
  )
}
