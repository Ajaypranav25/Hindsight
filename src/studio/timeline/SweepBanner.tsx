/**
 * The sweep banner above the strip chart (ARCHITECTURE §7.13, §11.3): one what-if per value of a
 * variable, their traces laid over the chart as ghosts and their outcomes in a table. A row opens
 * that run as an ordinary what-if; "Back to the real run" returns here.
 */
import { useEffect, useRef } from 'react'
import { formatLiteral, type Recording, type SweepRun } from '../../core/index'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import { liveSweep, type SweepState } from '../state/lab'
import './lab.css'

function outcomeText(recording: Recording): string {
  const { outcome } = recording
  if (outcome.kind === 'error') return `error ${outcome.error.code}`
  if (outcome.kind === 'finished') return 'finished'
  return outcome.kind === 'step-limit' ? 'step limit' : 'stopped'
}

function outputText(run: SweepRun): string {
  const changed = Math.max(run.comparison.removed, run.comparison.added)
  return changed === 0 ? 'same output' : `${formatCount(changed)} changed`
}

/** The index of the run with the most steps (the first of equals); -1 without runs. */
export function longestRun(runs: readonly SweepRun[]): number {
  let longest = -1
  runs.forEach((run, i) => {
    if (longest < 0 || run.recording.length > runs[longest]!.recording.length) longest = i
  })
  return longest
}

/** "start = 1..20 at step 1,144 · 20 runs" (or "· 7 of 20" while it runs). */
export function sweepHeadline(sweep: SweepState): string {
  const progress = sweep.running
    ? `${formatCount(sweep.done)} of ${formatCount(sweep.total)}`
    : `${formatCount(sweep.runs.length)} ${sweep.runs.length === 1 ? 'run' : 'runs'}`
  return `${sweep.label} at step ${formatCount(sweep.time)} · ${progress}`
}

/** `onClosed` runs after "Close sweep", whose button goes away with the banner. */
export function SweepBanner(props: { readonly onClosed?: () => void }) {
  const sweep = useStudio((s) => liveSweep(s.lab, s.recording))
  const { openSweepRun, closeSweep } = useStudioActions()
  const groupRef = useRef<HTMLDivElement>(null)
  const finished = sweep !== null && !sweep.running
  useEffect(() => {
    // The finished sweep takes focus from the what-if editor that started it (or from nowhere).
    const active = document.activeElement
    if (finished && (active === null || active === document.body)) groupRef.current?.focus()
  }, [finished])
  const headline = sweep ? sweepHeadline(sweep) : ''
  const longest = sweep ? longestRun(sweep.runs) : -1
  return (
    <>
      <p className="tl-visually-hidden" aria-live="polite">
        {sweep && !sweep.running ? `Sweep finished: ${headline}` : ''}
      </p>
      {sweep && (
        <div ref={groupRef} tabIndex={-1} className="tl-sweep" role="group" aria-label="Sweep">
          <div className="tl-sweep__head">
            <p className="tl-whatif__text">
              <span className="tl-whatif__head">Sweep {sweep.label}</span>
              <span className="tl-whatif__detail"> · {headline.slice(sweep.label.length + 1)}</span>
            </p>
            <button
              type="button"
              className="ch-button-small"
              onClick={() => {
                closeSweep()
                props.onClosed?.()
              }}
            >
              {sweep.running ? 'Stop' : 'Close sweep'}
            </button>
          </div>
          {(sweep.runs.length > 0 || sweep.failed.length > 0) && (
            <table className="tl-sweep__table">
              <thead>
                <tr>
                  <th scope="col">{sweep.name}</th>
                  <th scope="col">Steps</th>
                  <th scope="col">Deepest</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Output</th>
                </tr>
              </thead>
              <tbody>
                {sweep.runs.map((run, i) => (
                  <tr
                    key={i}
                    data-longest={i === longest && sweep.runs.length > 1 ? '' : undefined}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className="tl-sweep__open"
                        title="Open this run as a what-if"
                        onClick={() => openSweepRun(i)}
                      >
                        {formatLiteral(run.value)}
                      </button>
                    </th>
                    <td>
                      {formatCount(run.recording.length)}
                      {i === longest && sweep.runs.length > 1 ? ' · longest' : ''}
                    </td>
                    <td>{formatCount(run.maxDepth)}</td>
                    <td>{outcomeText(run.recording)}</td>
                    <td>{outputText(run)}</td>
                  </tr>
                ))}
                {sweep.failed.map((entry, i) => (
                  <tr key={`failed ${i}`}>
                    <th scope="row">{formatLiteral(entry.value)}</th>
                    <td colSpan={4}>{entry.error.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  )
}
