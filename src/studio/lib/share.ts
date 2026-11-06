/**
 * Share links carry the program in the URL fragment: `#src=` + base64url(UTF-8 source). Encoding is
 * synchronous so a "Copy link" click can write to the clipboard inside its own event handler.
 */
const PREFIX = 'src='
const TIME_PREFIX = 't='

/** Programs larger than this are not put in links (browsers truncate very long URLs). */
export const MAX_SHARED_SOURCE_LENGTH = 60_000

export function encodeSource(source: string): string {
  const bytes = new TextEncoder().encode(source)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The decoded source, or null when `encoded` is not valid base64url UTF-8. */
export function decodeSource(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return null
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * The fragment for a share link (including `#`), or null when the program is too large. With
 * `time`, it is a moment link: `#src=...&t=3500` opens with the pen at that step.
 */
export function shareFragment(source: string, time?: number | null): string | null {
  if (source.length > MAX_SHARED_SOURCE_LENGTH) return null
  const moment = time === undefined || time === null ? '' : `&${TIME_PREFIX}${Math.floor(time)}`
  return `#${PREFIX}${encodeSource(source)}${moment}`
}

/** A program from a link and, for a moment link, the pen's step. */
export interface SharedMoment {
  readonly source: string
  readonly time: number | null
}

/** The program (and moment) carried by a location fragment (`#src=...[&t=N]`), or null. */
export function momentFromFragment(fragment: string): SharedMoment | null {
  const body = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (!body.startsWith(PREFIX)) return null
  const [encoded = '', ...params] = body.slice(PREFIX.length).split('&')
  const source = decodeSource(encoded)
  if (source === null) return null
  const time = params.find((param) => /^t=\d{1,15}$/.test(param))
  return { source, time: time === undefined ? null : Number(time.slice(TIME_PREFIX.length)) }
}

/** The program carried by a location fragment (`#src=...`), or null. */
export function sourceFromFragment(fragment: string): string | null {
  return momentFromFragment(fragment)?.source ?? null
}

/** The parts of `window` the share-link handling uses (absent outside browsers). */
export interface ShareHost {
  readonly location?: { readonly hash: string; readonly pathname: string; readonly search: string }
  readonly history?: { replaceState(data: unknown, unused: string, url?: string): void }
  addEventListener?(type: 'hashchange', listener: () => void): void
  removeEventListener?(type: 'hashchange', listener: () => void): void
}

/**
 * Reads the program (and moment) from a `#src=` fragment and removes the fragment, so a link is
 * used once: afterwards edits persist and a reload shows them rather than the linked program.
 */
export function takeSharedMoment(host: ShareHost): SharedMoment | null {
  try {
    const location = host.location
    if (!location) return null
    const hash = location.hash
    const body = hash.startsWith('#') ? hash.slice(1) : hash
    if (!body.startsWith(PREFIX)) return null
    host.history?.replaceState(null, '', location.pathname + location.search)
    return momentFromFragment(hash)
  } catch {
    return null
  }
}

/** `takeSharedMoment` without the moment. */
export function takeSharedSource(host: ShareHost): string | null {
  return takeSharedMoment(host)?.source ?? null
}

/** Calls `load` with each program pasted into the address bar as a share link; returns a stop. */
export function watchSharedLinks(
  host: ShareHost,
  load: (source: string, time: number | null) => void,
): () => void {
  const listener = () => {
    const moment = takeSharedMoment(host)
    if (moment !== null) load(moment.source, moment.time)
  }
  host.addEventListener?.('hashchange', listener)
  return () => host.removeEventListener?.('hashchange', listener)
}
