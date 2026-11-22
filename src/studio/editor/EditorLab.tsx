/**
 * The editor's laboratory notes (ARCHITECTURE §7.8, §11.3): the chip that says how many lines led
 * to a crash (or to a step the user asked about) while the others are dimmed, with the causal
 * chain behind it. The slice is computed by the analysis service (a worker where there is one)
 * once the recording is on screen, never while typing.
 */
import { useEffect, useState } from 'react'
import { AnalysisCancelled } from '../analysis/local'
import type { CausalLink } from '../analysis/protocol'
import { analysisService } from '../analysis/service'
import { ContractsCard } from '../insight/ContractsCard'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import {
  activeSlice,
  MAX_AUTO_SLICE_STEPS,
  SLICE_FAILED,
  sliceMark,
  type SliceMark,
  wantedSliceStep,
} from '../state/lab'
import './lab.css'

/** Links the chip lists before "+N more". */
export const CHAIN_SHOWN = 4
/** A short pause before tracing, so a burst of changes traces only the last. */
const SLICE_DELAY_MS = 30

/** Computes the slice the editor wants once the recording is on screen. */
function useSliceComputation(): void {
  const recording = useStudio((s) => s.recording)
  const wanted = useStudio(wantedSliceStep)
  const have = useStudio((s) =>
    s.lab.slice !== null && s.lab.slice.recording === s.recording ? s.lab.slice.at : null,
  )
  const { setSlice } = useStudioActions()
  useEffect(() => {
    if (recording === null || wanted === null || wanted === have) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      analysisService()
        .analyze(recording, { kind: 'slice', at: wanted }, controller.signal)
        .then(
          (result) => {
            if (result.kind === 'slice') setSlice(sliceMark(recording, wanted, result.slice))
          },
          (error: unknown) => {
            if (error instanceof AnalysisCancelled) return
            setSlice(sliceMark(recording, wanted, null, SLICE_FAILED))
          },
        )
    }, SLICE_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [recording, wanted, have, setSlice])
}

export function EditorLab() {
  useSliceComputation()
  return (
    <div className="ed-lab">
      <ContractsCard />
      <SliceChip />
    </div>
  )
}

/** `total = 72 · step 410 · line 8`. */
export function linkText(link: CausalLink): string {
  const where = link.line === null ? 'library' : `line ${link.line}`
  return `${link.name} = ${link.value} · step ${formatCount(link.time)} · ${where}`
}

function SliceChip() {
  const recording = useStudio((s) => s.recording)
  const time = useStudio((s) => s.time)
  const stale = useStudio((s) => s.recordedSource !== s.source)
  const slice = useStudio(activeSlice)
  const wanted = useStudio(wantedSliceStep)
  const askedAt = useStudio((s) =>
    s.lab.sliceAt !== null && s.lab.sliceAt.recording === s.recording ? s.lab.sliceAt : null,
  )
  const asked = askedAt !== null
  const dimming = useStudio((s) => s.lab.dimming)
  const { setDimming, sliceFrom } = useStudioActions()
  if (recording === null || stale) return null
  const failed = recording.outcome.kind === 'error'
  const traceHere = (
    <button
      type="button"
      className="ch-button ch-button-small"
      title="Dim every line that had no part in what happens at the pen's step"
      onClick={() => sliceFrom(time)}
    >
      What led here?
    </button>
  )
  if (slice !== null && slice.lines !== null) {
    const lines = `${formatCount(slice.lines.size)} ${slice.lines.size === 1 ? 'line' : 'lines'}`
    const about =
      askedAt === null ? 'the error' : (askedAt.label ?? `step ${formatCount(slice.at)}`)
    return (
      <div className="ed-slice" role="group" aria-label="Lines that led here">
        <div className="ed-slice-head">
          <span className="ed-slice-text" aria-live="polite">
            {lines} led to {about}; the rest are dimmed
          </span>
          {time !== slice.at && traceHere}
          <button
            type="button"
            className="ch-button ch-button-small"
            onClick={() => (asked ? sliceFrom(null) : setDimming(false))}
          >
            Show all lines
          </button>
        </div>
        <CausalChain slice={slice} />
      </div>
    )
  }
  if (wanted !== null) {
    return (
      <div className="ed-slice">
        <span className="ed-slice-text" aria-live="polite">
          {slice !== null ? slice.problem : 'Tracing causes…'}
        </span>
        {slice !== null && asked && (
          <button
            type="button"
            className="ch-button ch-button-small"
            onClick={() => sliceFrom(null)}
          >
            Close
          </button>
        )}
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
      {traceHere}
    </div>
  )
}

/** The writes the sliced step was computed from, newest first; each moves the pen there. */
function CausalChain(props: { readonly slice: SliceMark }) {
  const { slice } = props
  const { seek } = useStudioActions()
  const [expanded, setExpanded] = useState<SliceMark | null>(null)
  if (slice.chain.length === 0) return null
  const open = expanded === slice
  const shown = open ? slice.chain : slice.chain.slice(0, CHAIN_SHOWN)
  const more = slice.chainTotal - shown.length
  const end = slice.recording.length
  return (
    <ol className="ed-chain" aria-label="Causal chain, newest first">
      {shown.map((link) => (
        <li key={`${link.time} ${link.name}`}>
          <button
            type="button"
            className="ed-chain-link"
            title="Go to just after this write"
            onClick={() => seek(Math.min(link.time + 1, end))}
          >
            {linkText(link)}
          </button>
        </li>
      ))}
      {more > 0 && (
        <li>
          {open || slice.chain.length <= shown.length ? (
            <span className="ed-chain-more">+{formatCount(more)} more</span>
          ) : (
            <button type="button" className="ed-chain-more" onClick={() => setExpanded(slice)}>
              +{formatCount(more)} more
            </button>
          )}
        </li>
      )}
    </ol>
  )
}
