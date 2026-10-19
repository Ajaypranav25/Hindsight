import { useMemo } from 'react'
import { useStudio, useStudioActions } from '../state/context'
import { useRunLabel } from './useRunLabel'
import { CloseIcon } from './icons'
import { staleBadge, statusLine, type StatusAction } from './status-model'
import './chrome.css'

/** The run's status, the stale badge and transient notices (announced politely). */
export function Status() {
  const runLabel = useRunLabel()
  const status = useStudio((s) => s.status)
  const recording = useStudio((s) => s.recording)
  const source = useStudio((s) => s.source)
  const recordedSource = useStudio((s) => s.recordedSource)
  const settings = useStudio((s) => s.settings)
  const compile = useStudio((s) => s.compile)
  const inputs = useMemo(
    () => ({ status, recording, source, recordedSource, settings, compile }),
    [status, recording, source, recordedSource, settings, compile],
  )
  const line = useMemo(() => statusLine(inputs), [inputs])
  const badge = useMemo(() => staleBadge(inputs, runLabel), [inputs, runLabel])
  const notice = useStudio((s) => s.notice)
  const actions = useStudioActions()

  const perform = (action: StatusAction) => {
    if (action === 'jump-to-end') actions.jumpToEnd()
    else void actions.extend()
  }

  const text = (
    <>
      <span className="ch-status-lamp" aria-hidden="true" />
      <span className="ch-status-head">{line.head}</span>
      {line.detail && <span className="ch-status-detail"> · {line.detail}</span>}
    </>
  )

  // A notice temporarily takes over the single status line, so the header never grows.
  return (
    <div className="ch-status" data-tone={line.tone} data-notice={notice !== null}>
      <div className="ch-status-line">
        {!notice && (
          <>
            {line.action ? (
              <button
                type="button"
                className="ch-status-text ch-status-link"
                title="Jump to the moment it failed"
                onClick={() => perform(line.action!)}
              >
                {text}
              </button>
            ) : (
              <span className="ch-status-text" role="status">
                {text}
              </span>
            )}
            {line.button && (
              <button
                type="button"
                className="ch-button ch-button-small"
                onClick={() => perform(line.button!.action)}
              >
                {line.button.label}
              </button>
            )}
            {badge && <span className="ch-stale">{badge}</span>}
          </>
        )}
        <div className="ch-notice-region" aria-live="polite" aria-atomic="true">
          {notice && (
            <p className="ch-notice" data-tone={notice.tone} title={notice.text}>
              <span className="ch-notice-text">{notice.text}</span>
              <button
                type="button"
                className="ch-button ch-icon-button ch-notice-close"
                aria-label="Dismiss message"
                onClick={actions.clearNotice}
              >
                <CloseIcon />
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
