/** The tape counter: where the pen is, as recorder digits, plus the line and function. */
import { useMemo } from 'react'
import { formatCount, tapeDigits } from '../lib/format'
import { locationText, tapeWidth } from '../lib/timeline-math'
import { useStudio } from '../state/context'
import './timeline.css'

export function TapeCounter() {
  const recording = useStudio((s) => s.recording)
  const time = useStudio((s) => s.time)
  const length = recording?.length ?? 0
  const width = tapeWidth(length)
  const where = useMemo(() => {
    if (!recording) return null
    const location = recording.locationAt(time)
    if (!location) return recording.outcome.kind === 'finished' ? 'finished' : 'end of run'
    const error = time === length && recording.outcome.kind === 'error' ? 'error · ' : ''
    return `${error}${locationText(location)} · depth ${location.depth}`
  }, [recording, time, length])
  const label = recording
    ? `Step ${formatCount(time)} of ${formatCount(length)}`
    : 'No recording yet'
  return (
    <div className="tl-counter" role="group" aria-label={label}>
      <div className={recording ? 'tl-counter__tape' : 'tl-counter__tape tl-counter__tape--idle'}>
        <span className="tl-counter__label" aria-hidden="true">
          Step
        </span>
        <span className="tl-counter__digits" aria-hidden="true">
          <span className="tl-counter__now">{tapeDigits(time, width)}</span>
          <span className="tl-counter__sep">/</span>
          <span className="tl-counter__total">{tapeDigits(length, width)}</span>
        </span>
      </div>
      <span className="tl-counter__where" title={where ?? undefined}>
        {where ?? 'Run a program to start the tape'}
      </span>
    </div>
  )
}
