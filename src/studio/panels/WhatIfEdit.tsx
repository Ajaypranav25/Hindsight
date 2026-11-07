/**
 * The "what if" affordance of a primitive value (ARCHITECTURE §11.3): a button beside the value
 * and an inline editor. Committing forks the run at the pen with the new value.
 */
import { useCallback, useEffect, useId, useRef, useState, type Ref, type RefObject } from 'react'
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

/**
 * Whether a value can be changed in a what-if: 'ready'; 'busy' while a recording is made (the
 * button stays, disabled, so focus can wait on it); 'none' without a recording or at its end.
 */
export type WhatIfAvailability = 'ready' | 'busy' | 'none'

export function useWhatIfAvailability(): WhatIfAvailability {
  return useStudio((s) => {
    if (s.recording === null || s.time >= s.recording.length) return 'none'
    return s.status.kind === 'recording' ? 'busy' : 'ready'
  })
}

/** Marks what-if buttons, so the banner knows focus was left there by an edit. */
export const WHAT_IF_TRIGGER = 'data-whatif-trigger'

export interface WhatIfEditing {
  readonly editing: boolean
  start(): void
  /** Ends the edit; `returnFocus` (Enter, Escape) puts focus back on the row's what-if button. */
  finish(returnFocus: boolean): void
  readonly buttonRef: RefObject<HTMLButtonElement | null>
}

/** One row's what-if editing state. */
export function useWhatIfEditing(): WhatIfEditing {
  const [editing, setEditing] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    buttonRef.current?.focus()
  }, [editing])
  const start = useCallback(() => setEditing(true), [])
  const finish = useCallback((returnFocus: boolean) => {
    // The blur of the removed input must not cancel the return asked for by a key.
    refocus.current ||= returnFocus
    setEditing(false)
  }, [])
  return { editing, start, finish, buttonRef }
}

/** A small button that starts editing a value. */
export function WhatIfButton({
  label,
  onClick,
  disabled = false,
  ref,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
  readonly ref?: Ref<HTMLButtonElement>
}) {
  const time = useStudio((s) => s.time)
  const text = `What if ${label} were different at step ${formatCount(time)}?`
  return (
    <button
      ref={ref}
      type="button"
      className="pn-act pn-act--word"
      aria-label={text}
      aria-disabled={disabled || undefined}
      title={text}
      onClick={disabled ? undefined : onClick}
      {...{ [WHAT_IF_TRIGGER]: '' }}
    >
      what if
    </button>
  )
}

const BUSY_MESSAGE = 'Still recording: press Enter again when it finishes'

/** The inline editor: Enter replays the future with the new value; Escape or leaving cancels. */
export function WhatIfInput(props: {
  readonly value: ValueView
  readonly target: WriteTarget
  readonly label: string
  /** `returnFocus` is true when a key ended the edit (focus then goes back to the row). */
  readonly onDone: (returnFocus: boolean) => void
}) {
  const { value, target, label, onDone } = props
  const { forkWhatIf } = useStudioActions()
  const busy = useWhatIfAvailability() === 'busy'
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
    // A fork waits for the recording in progress; closing now would drop the typed value.
    if (busy) return setError(BUSY_MESSAGE)
    onDone(true)
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
            onDone(true)
          }
        }}
        onBlur={() => onDone(false)}
      />
      <span id={errorId} className="pn-whatif-error" aria-live="polite">
        {error ?? ''}
      </span>
    </span>
  )
}
