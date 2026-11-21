import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { saveFile, traceDownload } from '../lib/trace-download'
import { useStudio, useStudioActions } from '../state/context'
import { ChevronIcon } from './icons'
import { usePopover } from './usePopover'
import './trace.css'

type Panel = 'menu' | 'problem'

/**
 * The Share menu's trace files (ARCHITECTURE §7.15): "Download trace" saves the run on display
 * (with its what-if edits and the pen) as a `.sighttrace` file; "Open trace…" opens one.
 */
export function TraceMenu() {
  const recording = useStudio((s) => s.recording)
  const base = useStudio((s) => s.whatIf?.parent ?? null)
  const time = useStudio((s) => s.time)
  const { openTraceFile } = useStudioActions()
  const { open, toggle, show, close, rootRef, triggerRef } = usePopover()
  const [panel, setPanel] = useState<Panel>('menu')
  const [problem, setProblem] = useState('')
  const listRef = useRef<HTMLUListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open && panel === 'menu')
      menuItems(listRef.current)
        .find((item) => !item.disabled)
        ?.focus()
  }, [open, panel])

  const openMenu = () => {
    setPanel('menu')
    toggle()
  }

  const download = async () => {
    close(true)
    if (!recording) return
    const result = await traceDownload({ recording, base, time })
    if (result.ok) return saveFile(result.bytes, result.name)
    setProblem(result.error)
    setPanel('problem')
    show()
  }

  const chooseFile = () => {
    close(true)
    inputRef.current?.click()
  }

  const fileChosen = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Cleared, so choosing the same file again still counts as a change.
    event.target.value = ''
    if (file) await openTraceFile(new Uint8Array(await file.arrayBuffer()))
  }

  return (
    <div className="ch-anchor" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ch-button ch-icon-button ch-trace-trigger"
        aria-label="Trace files"
        title="Trace files: download this run, or open one"
        aria-haspopup="menu"
        aria-expanded={open && panel === 'menu'}
        onClick={openMenu}
      >
        <ChevronIcon />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".sighttrace"
        hidden
        data-testid="trace-file-input"
        onChange={(event) => void fileChosen(event)}
      />
      {open && panel === 'menu' && (
        <ul
          ref={listRef}
          className="ch-pop ch-menu ch-trace-menu"
          role="menu"
          aria-label="Trace files"
          onKeyDown={(event) =>
            event.key === 'Tab' ? close(false) : moveFocus(event, listRef.current)
          }
        >
          <li role="none">
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="ch-menu-item"
              disabled={recording === null}
              onClick={() => void download()}
            >
              <span className="ch-menu-title">Download trace</span>
              <span className="ch-menu-summary">
                This run as a .sighttrace file, with its what-if edits and the pen
              </span>
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="ch-menu-item"
              onClick={chooseFile}
            >
              <span className="ch-menu-title">Open trace…</span>
              <span className="ch-menu-summary">
                Record a .sighttrace file again and go to its moment (or drop it on the editor)
              </span>
            </button>
          </li>
        </ul>
      )}
      {open && panel === 'problem' && (
        <div className="ch-pop ch-share-panel" role="alert">
          <p className="ch-share-text">This run cannot be saved as a trace: {problem}.</p>
        </div>
      )}
    </div>
  )
}

function menuItems(list: HTMLElement | null): HTMLButtonElement[] {
  return list ? Array.from(list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) : []
}

/** Arrow keys, Home and End move between the enabled items. */
function moveFocus(event: KeyboardEvent<HTMLElement>, list: HTMLElement | null): void {
  const items = menuItems(list).filter((item) => !item.disabled)
  if (items.length === 0) return
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const last = items.length - 1
  const targets: Readonly<Record<string, number>> = {
    ArrowDown: index < 0 || index === last ? 0 : index + 1,
    ArrowUp: index <= 0 ? last : index - 1,
    Home: 0,
    End: last,
  }
  const target = targets[event.key]
  if (target === undefined) return
  event.preventDefault()
  items[target]?.focus()
}
