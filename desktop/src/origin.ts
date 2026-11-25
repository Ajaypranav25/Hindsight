/**
 * Where the studio lives inside the app, and which other URLs it may reach. The studio is served
 * from a privileged custom scheme (app://studio/...) rather than file://, so it gets a real origin
 * (storage, a secure context for the clipboard) and nothing on disk outside the studio's own build.
 */

export const APP_SCHEME = 'app'
export const APP_HOST = 'studio'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const STUDIO_ENTRY_URL = `${APP_ORIGIN}/index.html`

/** Schemes the default browser or mail client opens on the studio's behalf. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Permissions the studio may use: only writing to the clipboard (its "Copy link" button). */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** True for URLs of the studio itself (app://studio/...). */
export function isAppUrl(url: string): boolean {
  const parsed = parse(url)
  return (
    parsed !== null &&
    parsed.protocol === `${APP_SCHEME}:` &&
    parsed.host === APP_HOST &&
    parsed.username === '' &&
    parsed.password === ''
  )
}

/**
 * The URL to hand to the operating system when the studio links somewhere else (a web page, an
 * email address), or null for anything the app must not open (file:, javascript:, custom schemes).
 */
export function externalUrl(url: string): string | null {
  const parsed = parse(url)
  return parsed !== null && EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
}

/** Whether the studio, at `requestingUrl`, may use `permission`; everything else is denied. */
export function isAllowedPermission(permission: string, requestingUrl: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl)
}
