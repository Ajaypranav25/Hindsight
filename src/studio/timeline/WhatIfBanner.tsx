/**
 * The what-if banner above the strip chart (ARCHITECTURE §11.3): what was changed, where the two
 * futures part, how the output changed, and the way back to the real run. Announced politely.
 */
import { useMemo } from 'react'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import { whatIfSummary } from '../state/what-if'

export function WhatIfBanner() {
  const whatIf = useStudio((s) => s.whatIf)
  const recording = useStudio((s) => s.recording)
  const { seek, leaveWhatIf } = useStudioActions()
  const summary = useMemo(
    () => (whatIf && recording ? whatIfSummary(whatIf, recording) : null),
    [whatIf, recording],
  )
  const divergence = whatIf?.comparison.divergence ?? null
  const sentence = summary ? `${summary.head} · ${summary.divergence} · ${summary.output}` : ''
  return (
    <>
      <p className="tl-visually-hidden" aria-live="polite">
        {sentence}
      </p>
      {summary && whatIf && (
        <div className="tl-whatif" role="group" aria-label="What if">
          <p
            className="tl-whatif__text"
            title={whatIf.edits.map((e) => `${e.text} at step ${formatCount(e.time)}`).join('\n')}
          >
            <span className="tl-whatif__head">{summary.head}</span>
            <span className="tl-whatif__detail">
              {' '}
              · {summary.divergence} · {summary.output}
            </span>
          </p>
          {divergence !== null && (
            <button type="button" className="ch-button-small" onClick={() => seek(divergence)}>
              Go to divergence
            </button>
          )}
          <button type="button" className="ch-button-small" onClick={leaveWhatIf}>
            Back to the real run
          </button>
        </div>
      )}
    </>
  )
}
