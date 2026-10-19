import { useStudio, useStudioActions } from '../state/context'
import { CloseIcon } from './icons'
import './chrome.css'

/** The one-line hint for first-time visitors; dismissing it is remembered. */
export function Hint() {
  const dismissed = useStudio((s) => s.hintDismissed)
  const { dismissHint } = useStudioActions()
  if (dismissed) return null
  return (
    <div className="ch-hint" role="note">
      <span className="ch-hint-pen" aria-hidden="true" />
      <p className="ch-hint-text">
        Drag the red pen to travel through time ·{' '}
        <span className="ch-hint-glyph" aria-hidden="true">
          ⟲
        </span>
        <span className="ch-sr">The origin button</span> shows where a value came from
      </p>
      <button
        type="button"
        className="ch-button ch-icon-button ch-hint-close"
        aria-label="Dismiss hint"
        onClick={dismissHint}
      >
        <CloseIcon />
      </button>
    </div>
  )
}
