import { useState } from 'react'
import { useStudio, useStudioActions } from '../state/context'
import type { Example } from '../state/types'
import { ExamplePicker } from './ExamplePicker'
import { HelpDialog } from './HelpDialog'
import { HelpIcon, RunIcon } from './icons'
import { Settings } from './Settings'
import { Share } from './Share'
import { Status } from './Status'
import { useRunLabel } from './useRunLabel'
import './chrome.css'

/** The instrument's top bar: wordmark, examples, Run, status, sharing, settings and help. */
export function Header(props: { examples?: readonly Example[] }) {
  const recording = useStudio((s) => s.status.kind === 'recording')
  const { run } = useStudioActions()
  const runLabel = useRunLabel()
  const [helpOpen, setHelpOpen] = useState(false)

  return (
    <header className="ch-header">
      <div className="ch-brand">
        <span className="ch-rec" data-on={recording} aria-hidden="true" />
        <span className="ch-wordmark">Hindsight</span>
        <span className="ch-model">Program recorder</span>
      </div>
      <ExamplePicker examples={props.examples} />
      <button
        type="button"
        className="ch-button ch-run"
        onClick={() => void run()}
        aria-keyshortcuts={runLabel === 'Ctrl+Enter' ? 'Control+Enter' : 'Meta+Enter'}
        title={`Record the program (${runLabel})`}
      >
        <RunIcon />
        <span>Run</span>
        <kbd className="ch-kbd ch-run-kbd">{runLabel}</kbd>
      </button>
      <div className="ch-header-status">
        <Status />
      </div>
      <div className="ch-tools">
        <Share />
        <Settings />
        <button
          type="button"
          className="ch-button ch-icon-button"
          aria-label="Help and shortcuts"
          aria-haspopup="dialog"
          onClick={() => setHelpOpen(true)}
        >
          <HelpIcon />
        </button>
      </div>
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </header>
  )
}
