import { useEffect, useRef, useState } from 'react'
import { formatCount } from '../lib/format'
import { MAX_SHARED_SOURCE_LENGTH, shareFragment } from '../lib/share'
import { useStudio } from '../state/context'
import { ShareIcon } from './icons'
import { usePopover } from './usePopover'

type ShareResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'copied' }
  | { readonly kind: 'manual'; readonly url: string }
  | { readonly kind: 'too-large' }

const COPIED_MS = 2000

/** The page address without its fragment. */
export function pageAddress(location: Pick<Location, 'origin' | 'pathname' | 'href'>): string {
  if (location.origin && location.origin !== 'null') return location.origin + location.pathname
  return location.href.split('#')[0] ?? ''
}

/**
 * "Copy link": writes a link carrying the program to the clipboard inside the click handler. When
 * the clipboard refuses, a popover shows the link selected for manual copying.
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
    const fragment = shareFragment(source)
    if (fragment === null) {
      setResult({ kind: 'too-large' })
      show()
      return
    }
    const url = pageAddress(window.location) + fragment
    const fallback = () => {
      setResult({ kind: 'manual', url })
      show()
    }
    const clipboard = navigator.clipboard as Clipboard | undefined
    if (!clipboard?.writeText) return fallback()
    clipboard.writeText(url).then(() => setResult({ kind: 'copied' }), fallback)
  }

  return (
    <div className="ch-anchor" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ch-button ch-share"
        onClick={copy}
        aria-label={result.kind === 'copied' ? 'Link copied' : 'Copy a link to this program'}
      >
        <ShareIcon />
        <span className="ch-collapsible-label">
          {result.kind === 'copied' ? 'Copied' : 'Copy link'}
        </span>
      </button>
      <span className="ch-sr" aria-live="polite">
        {result.kind === 'copied' ? 'Link copied to the clipboard' : ''}
      </span>
      {open && result.kind === 'manual' && <ManualCopy url={result.url} />}
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

function ManualCopy(props: { url: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <div className="ch-pop ch-share-panel" role="dialog" aria-label="Copy this link">
      <label className="ch-label" htmlFor="ch-share-url">
        Copy this link
      </label>
      <input
        ref={inputRef}
        id="ch-share-url"
        className="ch-share-url"
        readOnly
        value={props.url}
        onFocus={(event) => event.target.select()}
      />
      <p className="ch-note">The clipboard is not available here. Press Ctrl+C or ⌘ C to copy.</p>
    </div>
  )
}
