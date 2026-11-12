import { useMemo } from 'react'
import {
  callTree,
  type Recording,
  type Repair,
  repairExamples,
  type RepairRequest,
  type RepairResult,
  repairSearch,
  verdict,
} from '../../core/index'
import { liveSession } from '../state/bug-finder'
import { useStudio, useStudioActions } from '../state/context'
import { useGeneratorSearch } from '../state/use-search'

/**
 * Repair previews (ARCHITECTURE §7.12, §11.3): one-token changes to the function the bug was
 * isolated to that agree with every answer given. The search runs in the background; nothing is
 * shown until it has found something.
 */
export function RepairPreviews(props: {
  readonly recording: Recording
  readonly request: RepairRequest
  /** What the previews were checked against, for the note under the heading. */
  readonly basis: string
}) {
  const { recording, request, basis } = props
  const search = useGeneratorSearch<RepairResult>(request, () => repairSearch(recording, request))
  const { setSource } = useStudioActions()
  if (search.status !== 'done') {
    return search.status === 'searching' ? (
      <p className="pn-note bf-repairs-status">Looking for a one-token fix…</p>
    ) : null
  }
  const { repairs } = search.result
  if (repairs.length === 0) return null
  return (
    <section className="bf-repairs" aria-label="Repair previews">
      <h4 className="pn-label">Repair previews</h4>
      <p className="pn-note">
        {repairs.length === 1 ? 'This one-token change agrees' : 'These one-token changes agree'}{' '}
        with {basis}. A preview is not a proof: check that it is what you meant.
      </p>
      <ul className="bf-repair-list">
        {repairs.map((repair) => (
          <RepairRow key={`${repair.line} ${repair.change}`} repair={repair} onApply={setSource} />
        ))}
      </ul>
    </section>
  )
}

function RepairRow(props: { readonly repair: Repair; readonly onApply: (source: string) => void }) {
  const { repair, onApply } = props
  return (
    <li className="bf-repair">
      <p className="bf-repair-where">
        Line {repair.line}: <code>{repair.change.replaceAll('`', '')}</code>
      </p>
      <pre className="bf-repair-diff" aria-label={`Line ${repair.line} before and after`}>
        <span className="bf-repair-before">- {repair.before.trim()}</span>
        {'\n'}
        <span className="bf-repair-after">+ {repair.after.trim()}</span>
      </pre>
      {repair.now.map((now) => (
        <p key={now} className="pn-note">
          {now}
        </p>
      ))}
      <button
        type="button"
        className="ch-button ch-button-small"
        onClick={() => onApply(repair.source)}
      >
        Apply this change
      </button>
    </li>
  )
}

/** The previews for the open interview's verdict (nothing while a question is open). */
export function InterviewRepairs() {
  const recording = useStudio((s) => s.recording)
  const bugFinder = useStudio((s) => s.bugFinder)
  const session = liveSession(bugFinder, recording)
  const request = useMemo((): RepairRequest | null => {
    if (session === null) return null
    const found = verdict(session.finder)
    if (found.kind !== 'found') return null
    const examples = repairExamples(callTree(session.recording), session.finder)
    return { kind: 'examples', protoId: found.call.protoId, examples }
  }, [session])
  if (session === null || request === null) return null
  return <RepairPreviews recording={session.recording} request={request} basis="your answers" />
}
