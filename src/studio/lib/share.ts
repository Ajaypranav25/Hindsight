/**
 * Share links carry the program in the URL fragment: `#src=` + base64url(UTF-8 source). Encoding is
 * synchronous so a "Copy link" click can write to the clipboard inside its own event handler.
 */
const PREFIX = 'src='

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

/** The fragment for a share link (including `#`), or null when the program is too large. */
export function shareFragment(source: string): string | null {
  if (source.length > MAX_SHARED_SOURCE_LENGTH) return null
  return `#${PREFIX}${encodeSource(source)}`
}

/** The program carried by a location fragment (`#src=…`), or null. */
export function sourceFromFragment(fragment: string): string | null {
  const body = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (!body.startsWith(PREFIX)) return null
  return decodeSource(body.slice(PREFIX.length))
}
