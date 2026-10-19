import { useEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { shortcutList } from '../lib/shortcuts'
import { CHEAT_SHEET } from './cheatsheet'
import { CloseIcon } from './icons'
import { useApplePlatform } from './useRunLabel'
import './chrome.css'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/** A modal with every shortcut and a one-page language cheat sheet. */
export function HelpDialog(props: { open: boolean; onClose: () => void }) {
  if (!props.open) return null
  return createPortal(<HelpContent onClose={props.onClose} />, document.body)
}

function HelpContent(props: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const apple = useApplePlatform()

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLElement>('.ch-dialog-close')?.focus()
    return () => opener?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
    } else if (event.key === 'Tab') trapFocus(event, dialogRef.current)
  }

  return (
    <div
      className="ch-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        ref={dialogRef}
        className="ch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ch-help-title"
        onKeyDown={onKeyDown}
      >
        <header className="ch-dialog-head">
          <h2 id="ch-help-title" className="ch-dialog-title">
            Help
          </h2>
          <button
            type="button"
            className="ch-button ch-icon-button ch-dialog-close"
            aria-label="Close help"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="ch-dialog-body" tabIndex={0}>
          <section aria-labelledby="ch-help-keys">
            <h3 id="ch-help-keys" className="ch-label">
              Keyboard
            </h3>
            <table className="ch-keys">
              <tbody>
                {shortcutList(apple).map((item) => (
                  <tr key={item.action}>
                    <th scope="row">
                      {item.keys.map((key) => (
                        <kbd key={key} className="ch-kbd">
                          {key}
                        </kbd>
                      ))}
                    </th>
                    <td>{item.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section aria-labelledby="ch-help-language">
            <h3 id="ch-help-language" className="ch-label">
              The language
            </h3>
            <div className="ch-cheats">
              {CHEAT_SHEET.map((section) => (
                <div key={section.title} className="ch-cheat">
                  <h4 className="ch-cheat-title">{section.title}</h4>
                  <pre className="ch-cheat-code">{section.code}</pre>
                  {section.note && <p className="ch-note">{section.note}</p>}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

/** Keeps Tab and Shift+Tab inside the dialog. */
function trapFocus(event: KeyboardEvent<HTMLElement>, dialog: HTMLElement | null): void {
  if (!dialog) return
  const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
  if (items.length === 0) return
  const first = items[0]!
  const last = items[items.length - 1]!
  const active = document.activeElement
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}
