/**
 * "Since your edit" (ARCHITECTURE §11.3): when an edited program has been recorded again, the
 * run before the edit and the new one are compared by behaviour (differential execution, §7.14)
 * once the new run is on screen. A one-line strip says what changed: output lines, where the
 * change starts, how many calls behave differently; Show lists the origins, the changed calls
 * (old result → new result) and the output lines, each moving the pen in the new run. The diff
 * runs in the analysis service (bounded, skipped for long runs), so typing is never held up.
 */
import { type ReactNode, useMemo, useState } from 'react'
import type { ChangedCall, OriginGroup, OutputDiffLine } from '../../core/index'
import { describeRun } from '../analysis/run-description'
import { formatCount } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import type { EditRun } from '../state/types'
import type { EditDiffSummary } from './insight-protocol'
import { useInsight } from './use-insight'
import './insight.css'

/** Runs longer than this are not compared after an edit. */
export const EDIT_DIFF_MAX_STEPS = 300_000
/** Entries per list. */
export const EDIT_DIFF_LIMIT = 20

/** The edit behind the shown run, while the run is current and short enough to compare. */
function useComparableEdit(): EditRun | null {
  return useStudio((s) => {
    const edit = s.editRun
    if (edit === null || edit.recording !== s.recording || s.recordedSource !== s.source) {
      return null
    }
    const short =
      edit.previous.length <= EDIT_DIFF_MAX_STEPS && edit.recording.length <= EDIT_DIFF_MAX_STEPS
    return short ? edit : null
  })
}

export function EditDiffStrip() {
  const edit = useComparableEdit()
  const request = useMemo(() => {
    const previous = edit === null ? null : describeRun(edit.previous)
    return previous === null ? null : { kind: 'runDiff' as const, previous, limit: EDIT_DIFF_LIMIT }
  }, [edit])
  const state = useInsight(edit?.recording ?? null, request)
  const [dismissed, setDismissed] = useState<EditRun | null>(null)
  const [open, setOpen] = useState<EditRun | null>(null)
  if (edit === null || dismissed === edit || state.status !== 'done') return null
  const diff = state.value.diff
  if (diff === null) return null
  const expanded = open === edit
  return (
    <section className="in-edit" aria-label="Since your edit">
      <div className="in-edit-bar">
        <span className="in-edit-label">Since your edit</span>
        <span className="in-edit-text" aria-live="polite">
          {summaryParts(diff, edit).join(' · ')}
        </span>
        {!diff.same && (
          <button
            type="button"
            className="ch-button ch-button-small"
            aria-expanded={expanded}
            onClick={() => setOpen(expanded ? null : edit)}
          >
            {expanded ? 'Hide' : 'Show'}
          </button>
        )}
        <button
          type="button"
          className="ch-button ch-button-small"
          aria-label="Dismiss the behaviour diff"
          onClick={() => setDismissed(edit)}
        >
          ×
        </button>
      </div>
      {expanded && <EditDiffDetails diff={diff} />}
    </section>
  )
}

/** `output −2 +3 · starts in average · 4 changed calls · pen kept in fib`. */
export function summaryParts(diff: EditDiffSummary, edit: EditRun): string[] {
  const parts: string[] = []
  if (diff.same) parts.push('behaves the same')
  if (!diff.sameOutcome) parts.push('the outcome changed')
  if (diff.removed + diff.added > 0) {
    parts.push(`output −${formatCount(diff.removed)} +${formatCount(diff.added)}`)
  }
  const origin = diff.origins[0]
  if (origin !== undefined) parts.push(`starts in ${origin.b.name}`)
  if (diff.changedTotal > 0) {
    parts.push(
      `${formatCount(diff.changedTotal)} changed ${diff.changedTotal === 1 ? 'call' : 'calls'}`,
    )
  }
  const structural = diff.onlyOld + diff.onlyNew
  if (structural > 0 && diff.changedTotal === 0) {
    parts.push(`${formatCount(structural)} ${structural === 1 ? 'call' : 'calls'} added or gone`)
  }
  const place = edit.place
  if (place !== null && place.precision !== 'clamped' && place.precision !== 'end') {
    parts.push(`pen kept in ${place.call}`)
  }
  return parts
}

function EditDiffDetails(props: { readonly diff: EditDiffSummary }) {
  const { diff } = props
  const { seek } = useStudioActions()
  return (
    <div className="in-edit-details">
      {diff.origins.length > 0 && (
        <DiffList title="Where the change starts">
          {diff.origins.map((origin) => (
            <CallItem key={`${origin.b.entry}`} change={origin} onSeek={seek} />
          ))}
        </DiffList>
      )}
      {diff.changed.length > 0 && (
        <DiffList title="Changed calls" more={diff.changedTotal - diff.changed.length}>
          {diff.changed.map((change) => (
            <CallItem key={`${change.b.entry}`} change={change} onSeek={seek} />
          ))}
        </DiffList>
      )}
      {diff.outputLines.length > 0 && (
        <DiffList title="Output" more={diff.removed + diff.added - diff.outputLines.length}>
          {diff.outputLines.map((line, index) => (
            <OutputItem key={index} line={line} onSeek={seek} />
          ))}
        </DiffList>
      )}
      {diff.onlyOld + diff.onlyNew > 0 && (
        <p className="in-contracts-note">
          {formatCount(diff.onlyOld)} {diff.onlyOld === 1 ? 'call' : 'calls'} only before the edit,{' '}
          {formatCount(diff.onlyNew)} only after it.
        </p>
      )}
      {diff.truncated && (
        <p className="in-contracts-note">
          The runs are large: only part of their calls was compared.
        </p>
      )}
    </div>
  )
}

function DiffList(props: {
  readonly title: string
  readonly more?: number
  readonly children: ReactNode
}) {
  return (
    <div className="in-edit-list">
      <h3 className="in-edit-heading">{props.title}</h3>
      <ul>{props.children}</ul>
      {props.more !== undefined && props.more > 0 && (
        <p className="in-contracts-note">+{formatCount(props.more)} more</p>
      )}
    </div>
  )
}

/** `average(xs = [1, 2]): returned 1.5 → returned 1`; moves the pen to the call in the new run. */
function CallItem(props: {
  readonly change: ChangedCall | OriginGroup
  readonly onSeek: (time: number) => void
}) {
  const { change, onSeek } = props
  const count = 'count' in change && change.count > 1 ? ` ×${formatCount(change.count)}` : ''
  return (
    <li>
      <button
        type="button"
        className="in-edit-item"
        title="Go to this call in the new run"
        onClick={() => onSeek(change.b.entry)}
      >
        <span className="in-edit-call">
          {change.b.signature}
          {count}
        </span>
        <span className="in-edit-change">{changeText(change)}</span>
      </button>
    </li>
  )
}

const ASPECT_WORDS: Readonly<Record<ChangedCall['changes'][number], string>> = {
  arguments: 'its arguments',
  context: 'what it read',
  outcome: 'its outcome',
  result: 'its result',
  error: 'its error',
  effects: 'its side effects',
  output: 'its output',
  calls: 'the calls it made',
}

/** `returned 4 → returned 6`, or what changed when that reads the same: `its output changed`. */
export function changeText(change: ChangedCall): string {
  if (change.a.did !== change.b.did) return `${change.a.did} → ${change.b.did}`
  const aspects = change.changes.map((aspect) => ASPECT_WORDS[aspect])
  return aspects.length === 0 ? change.b.did : `${aspects.join(', ')} changed`
}

function OutputItem(props: {
  readonly line: OutputDiffLine
  readonly onSeek: (time: number) => void
}) {
  const { line, onSeek } = props
  const sign = line.kind === 'removed' ? '−' : '+'
  const text = `${sign} ${line.text}`
  const time = line.kind === 'added' ? line.timeB : null
  if (time === null) {
    return (
      <li className="in-edit-output in-edit-output--removed">
        <span>{text}</span>
      </li>
    )
  }
  return (
    <li className="in-edit-output">
      <button
        type="button"
        className="in-edit-item"
        title="Go to where the new run printed it"
        onClick={() => onSeek(time)}
      >
        {text}
      </button>
    </li>
  )
}
