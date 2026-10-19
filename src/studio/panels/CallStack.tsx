import { useMemo } from 'react'
import type { FrameView, RuntimeErrorInfo } from '../../core/index'
import { getLibrarySource, LineIndex } from '../../core/index'
import { formatCount } from '../lib/format'
import { useStateView, useStudio, useStudioActions } from '../state/context'
import { selectedFrame, visibleFrames } from '../state/selectors'
import { localsSummary } from './panel-logic'
import './panels.css'

/** The frames at the pen, innermost first; clicking one selects it. */
export function CallStack() {
  const recording = useStudio((s) => s.recording)
  const time = useStudio((s) => s.time)
  const justMyCode = useStudio((s) => s.settings.justMyCode)
  const selectedUid = useStudio((s) => s.selectedFrameUid)
  const view = useStateView()
  const { selectFrame } = useStudioActions()
  if (!recording || !view) return <p className="pn-empty">Run the program to see its call stack</p>
  const outcome = recording.outcome
  const failedHere = outcome.kind === 'error' && time === recording.length
  if (view.frames.length === 0) {
    if (outcome.kind === 'error')
      return <ErrorStack error={outcome.error} source={recording.program.source} />
    return (
      <div className="pn-finished">
        <span className="pn-label">Program finished</span>
        <span className="pn-value">{formatCount(recording.length)} steps</span>
      </div>
    )
  }
  const frames = visibleFrames(view, justMyCode)
  const innermost = view.frames[view.frames.length - 1]!
  const selected = selectedFrame(view, selectedUid)
  const hidden = view.frames.length - frames.length
  return (
    <div className="pn-stack-wrap">
      {failedHere && outcome.kind === 'error' && (
        <p className="pn-stack-error">
          <span className="pn-code">{outcome.error.code}</span> {outcome.error.message}
        </p>
      )}
      <ol className="pn-stack" aria-label="Call stack, innermost first">
        {frames.map((frame) => (
          <FrameRow
            key={frame.uid}
            frame={frame}
            selected={frame.uid === selected?.uid}
            onSelect={() => selectFrame(frame.uid === innermost.uid ? null : frame.uid)}
          />
        ))}
      </ol>
      {hidden > 0 && (
        <p className="pn-note pn-pad">
          {hidden} library {hidden === 1 ? 'frame' : 'frames'} hidden (just my code)
        </p>
      )}
    </div>
  )
}

function FrameRow(props: {
  readonly frame: FrameView
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  const { frame, selected, onSelect } = props
  const summary = localsSummary(frame.locals)
  return (
    <li>
      <button
        type="button"
        className={`pn-frame${frame.library ? ' pn-frame--library' : ''}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="pn-frame-head">
          <span className="pn-frame-name">{frame.name}</span>
          <span className="pn-frame-line">
            {frame.library ? 'library · ' : ''}line {frame.line}
          </span>
        </span>
        {summary && <span className="pn-frame-locals">{summary}</span>}
      </button>
    </li>
  )
}

/** The stack recorded with a runtime error, when the state at the pen has no frames. */
function ErrorStack(props: { readonly error: RuntimeErrorInfo; readonly source: string }) {
  const { error, source } = props
  const lines = useMemo(
    () => ({ main: new LineIndex(source), library: new LineIndex(getLibrarySource()) }),
    [source],
  )
  return (
    <div className="pn-stack-wrap">
      <p className="pn-stack-error">
        <span className="pn-code">{error.code}</span> {error.message}
      </p>
      <ol className="pn-stack" aria-label="Call stack at the failure, innermost first">
        {error.stack.map((entry, i) => (
          <li
            key={i}
            className={`pn-frame pn-frame--static${entry.library ? ' pn-frame--library' : ''}`}
          >
            <span className="pn-frame-head">
              <span className="pn-frame-name">{entry.name}</span>
              <span className="pn-frame-line">
                {entry.library ? 'library · ' : ''}line{' '}
                {(entry.library ? lines.library : lines.main).lineOf(entry.span.start)}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
