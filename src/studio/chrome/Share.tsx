import { useEffect, useRef, useState } from 'react'
import { appLink, desktopBridge, MAX_APP_LINK_LENGTH } from '../desktop/bridge'
import { formatCount } from '../lib/format'
import { MAX_SHARED_SOURCE_LENGTH, shareFragment } from '../lib/share'
import { useStudio } from '../state/context'
import { momentTime } from '../state/selectors'
import { ShareIcon } from './icons'
import { TraceMenu } from './TraceMenu'
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

/**
 * What "Copy link" copies: inside the desktop app a `hindsight://` link, which opens the program in
 * the app on any machine that has it; in a browser a link to this page, or the source text.
 */
type CopyMode = 'app-link' | 'link' | 'source'

function copyMode(): CopyMode {
  if (desktopBridge() !== null) return 'app-link'
  return COPY_SOURCE ? 'source' : 'link'
}

/** The page address without its fragment. */
export function pageAddress(location: Pick<Location, 'origin' | 'pathname' | 'href'>): string {
  if (location.origin && location.origin !== 'null') return location.origin + location.pathname
  return location.href.split('#')[0] ?? ''
}

function linkTo(source: string, time: number | null): string | null {
  const fragment = shareFragment(source, time)
  return fragment === null ? null : pageAddress(window.location) + fragment
}

/** The text to copy, or null when the program is too long for a link. */
function textToCopy(mode: CopyMode, source: string, time: number | null): string | null {
  if (mode === 'source') return source
  return mode === 'app-link' ? appLink(source, time) : linkTo(source, time)
}

/**
 * Why there is no link. App links are shorter because Windows hands them to the app on a command
 * line, and the app can open the program's file instead.
 */
function tooLongText(mode: CopyMode): string {
  const limit = mode === 'app-link' ? MAX_APP_LINK_LENGTH : MAX_SHARED_SOURCE_LENGTH
  const text = `This program is too long to fit in a link. Links hold up to ${formatCount(limit)}`
  if (mode !== 'app-link') return `${text} characters.`
  return `${text} characters, so save it as a file (File > Save) and share the file instead.`
}

/**
 * "Copy link": writes a link carrying the program to the clipboard inside the click handler. When
 * the clipboard refuses, a popover shows the text selected for manual copying. Beside it, the
 * trace files menu downloads and opens `.sighttrace` files.
 */
export function Share() {
  return (
    <div className="ch-share-group">
      <CopyLink />
      <TraceMenu />
    </div>
  )
}

function CopyLink() {
  const source = useStudio((s) => s.source)
  const time = useStudio(momentTime)
  const { open, show, rootRef, triggerRef } = usePopover()
  const [result, setResult] = useState<ShareResult>({ kind: 'none' })
  const [mode] = useState(copyMode)

  useEffect(() => {
    if (result.kind !== 'copied') return
    const timer = window.setTimeout(() => setResult({ kind: 'none' }), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [result])

  const copy = () => {
    const text = textToCopy(mode, source, time)
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

  const noun = mode === 'source' ? 'Program' : 'Link'
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
            : mode === 'source'
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
        <ManualCopy text={result.text} multiline={mode === 'source'} />
      )}
      {open && result.kind === 'too-large' && (
        <div className="ch-pop ch-share-panel" role="dialog" aria-label="Link not available">
          <p className="ch-share-text">{tooLongText(mode)}</p>
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
