/**
 * The editor's laboratory notes (ARCHITECTURE §7.8, §7.10, §11.3): the explanation of why a line
 * did not run, and the chip that says how many lines led to a crash (or to the pen's step) while
 * the others are dimmed.
 */
import { useEffect, useRef } from 'react'
import { backwardSlice } from '../../core/index'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import { activeSlice, liveWhyNot, MAX_AUTO_SLICE_STEPS, wantedSliceStep } from '../state/lab'
import { whyNotMoment } from './lab-lines'
import './lab.css'

/** Computes the slice the editor wants once the recording is on screen, never while typing. */
function useSliceComputation(): void {
  const recording = useStudio((s) => s.recording)
  const wanted = useStudio(wantedSliceStep)
  const have = useStudio((s) =>
    s.lab.slice !== null && s.lab.slice.recording === s.recording ? s.lab.slice.at : null,
  )
  const { setSlice } = useStudioActions()
  useEffect(() => {
    if (recording === null || wanted === null || wanted === have) return
    const timer = setTimeout(() => {
      const slice = backwardSlice(recording, wanted)
      setSlice({ recording, at: wanted, lines: slice?.lines ?? null })
    }, 30)
    return () => clearTimeout(timer)
  }, [recording, wanted, have, setSlice])
}

export function EditorLab() {
  useSliceComputation()
  return (
    <div className="ed-lab">
      <WhyNotNote />
      <SliceChip />
    </div>
  )
}

function WhyNotNote() {
  const mark = useStudio((s) => liveWhyNot(s.lab, s.recording))
  const { closeWhyNot, seek } = useStudioActions()
  const note = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (mark !== null) note.current?.focus()
  }, [mark])
  if (mark === null) return null
  const moment = whyNotMoment(mark.why)
  return (
    <div
      ref={note}
      className="ed-why"
      role="group"
      aria-label={`Why line ${mark.line} did not run`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        closeWhyNot()
      }}
    >
      <p className="ed-why-text">{mark.why.sentence}</p>
      <div className="ed-why-tools">
        {moment !== null && (
          <button type="button" className="ch-button ch-button-small" onClick={() => seek(moment)}>
            {mark.why.kind === 'cut-short' ? 'Go to where the run stopped' : 'Go to the decision'}
          </button>
        )}
        <button type="button" className="ch-button ch-button-small" onClick={closeWhyNot}>
          Close
        </button>
      </div>
    </div>
  )
}

function SliceChip() {
  const recording = useStudio((s) => s.recording)
  const time = useStudio((s) => s.time)
  const stale = useStudio((s) => s.recordedSource !== s.source)
  const slice = useStudio(activeSlice)
  const wanted = useStudio(wantedSliceStep)
  const dimming = useStudio((s) => s.lab.dimming)
  const { setDimming, sliceFrom } = useStudioActions()
  if (recording === null || stale) return null
  const failed = recording.outcome.kind === 'error'
  const asked = wanted !== null && !(failed && wanted === recording.length)
  if (slice !== null && slice.lines !== null) {
    const lines = `${formatCount(slice.lines.size)} ${slice.lines.size === 1 ? 'line' : 'lines'}`
    const about = asked ? `step ${formatCount(slice.at)}` : 'the error'
    return (
      <div className="ed-slice" role="group" aria-label="Lines that led here">
        <span className="ed-slice-text" aria-live="polite">
          {lines} led to {about}; the rest are dimmed
        </span>
        <button
          type="button"
          className="ch-button ch-button-small"
          onClick={() => (asked ? sliceFrom(null) : setDimming(false))}
        >
          Show all lines
        </button>
      </div>
    )
  }
  if (wanted !== null) {
    return (
      <div className="ed-slice">
        <span className="ed-slice-text">
          {slice !== null ? 'This run is too long to trace' : 'Tracing causes…'}
        </span>
      </div>
    )
  }
  const tooLong = recording.length > MAX_AUTO_SLICE_STEPS
  return (
    <div className="ed-slice">
      {failed && !dimming && !tooLong && (
        <button
          type="button"
          className="ch-button ch-button-small"
          onClick={() => setDimming(true)}
        >
          Dim unrelated lines
        </button>
      )}
      <button
        type="button"
        className="ch-button ch-button-small"
        title="Dim every line that had no part in what happens at the pen's step"
        onClick={() => sliceFrom(time)}
      >
        What led here?
      </button>
    </div>
  )
}
