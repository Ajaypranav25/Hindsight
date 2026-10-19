import { useEffect, useRef, useState } from 'react'
import { formatCount } from '../lib/format'
import { MAX_SHARED_SOURCE_LENGTH, shareFragment } from '../lib/share'
import { useStudio } from '../state/context'
import { ShareIcon } from './icons'
import { usePopover } from './usePopover'

type ShareResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'copied' }
  | { readonly kind: 'manual'; readonly text: string }
  | { readonly kind: 'too-large' }

const COPIED_MS = 2000

/**
 * The single-page build is hosted where links cannot carry a program (only plain #anchors reach the
 * page), so there the button copies the program's source text instead of a link.
 */
const COPY_SOURCE = import.meta.env.VITE_SHARE_MODE === 'source'

/** The page address without its fragment. */
export function pageAddress(location: Pick<Location, 'origin' | 'pathname' | 'href'>): string {
  if (location.origin && location.origin !== 'null') return location.origin + location.pathname
  return location.href.split('#')[0] ?? ''
}

function linkTo(source: string): string | null {
  const fragment = shareFragment(source)
  return fragment === null ? null : pageAddress(window.location) + fragment
}

/**
 * "Copy link": writes a link carrying the program to the clipboard inside the click handler. When
 * the clipboard refuses, a popover shows the text selected for manual copying.
 */
export function Share() {
  const source = useStudio((s) => s.source)
  const { open, show, rootRef, triggerRef } = usePopover()
  const [result, setResult] = useState<ShareResult>({ kind: 'none' })

  useEffect(() => {
    if (result.kind !== 'copied') return
    const timer = window.setTimeout(() => setResult({ kind: 'none' }), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [result])

  const copy = () => {
    const text = COPY_SOURCE ? source : linkTo(source)
    if (text === null) {
      setResult({ kind: 'too-large' })
      show()
      return
    }
    const fallback = () => {
      setResult({ kind: 'manual', text })
      show()
    }
    const clipboard = navigator.clipboard as Clipboard | undefined
    if (!clipboard?.writeText) return fallback()
    clipboard.writeText(text).then(() => setResult({ kind: 'copied' }), fallback)
  }

  const noun = COPY_SOURCE ? 'Program' : 'Link'
  return (
    <div className="ch-anchor" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ch-button ch-share"
        onClick={copy}
        aria-label={
          result.kind === 'copied'
            ? `${noun} copied`
            : COPY_SOURCE
              ? "Copy this program's source"
              : 'Copy a link to this program'
        }
      >
        <ShareIcon />
        <span className="ch-collapsible-label">
          {result.kind === 'copied' ? 'Copied' : `Copy ${noun.toLowerCase()}`}
        </span>
      </button>
      <span className="ch-sr" aria-live="polite">
        {result.kind === 'copied' ? `${noun} copied to the clipboard` : ''}
      </span>
      {open && result.kind === 'manual' && (
        <ManualCopy text={result.text} multiline={COPY_SOURCE} />
      )}
      {open && result.kind === 'too-large' && (
        <div className="ch-pop ch-share-panel" role="dialog" aria-label="Link not available">
          <p className="ch-share-text">
            This program is too long to fit in a link. Links hold up to{' '}
            {formatCount(MAX_SHARED_SOURCE_LENGTH)} characters.
          </p>
        </div>
      )}
    </div>
  )
}

function ManualCopy(props: { text: string; multiline: boolean }) {
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  useEffect(() => {
    fieldRef.current?.focus()
    fieldRef.current?.select()
  }, [])
  const label = props.multiline ? 'Copy this program' : 'Copy this link'
  return (
    <div className="ch-pop ch-share-panel" role="dialog" aria-label={label}>
      <label className="ch-label" htmlFor="ch-share-url">
        {label}
      </label>
      {props.multiline ? (
        <textarea
          ref={fieldRef}
          id="ch-share-url"
          className="ch-share-url"
          readOnly
          rows={8}
          value={props.text}
          onFocus={(event) => event.target.select()}
        />
      ) : (
        <input
          ref={fieldRef}
          id="ch-share-url"
          className="ch-share-url"
          readOnly
          value={props.text}
          onFocus={(event) => event.target.select()}
        />
      )}
      <p className="ch-note">The clipboard is not available here. Press Ctrl+C or ⌘ C to copy.</p>
    </div>
  )
}
