/**
 * "Open in Studio": a moment link (`#src=<base64url source>&t=<step>`), built with the studio's own
 * encoder so the two can never disagree. By default it is a `hindsight://open` link, which opens the
 * program in the Hindsight desktop app; links hold up to 30,000 characters there, because Windows
 * hands them to the app on a command line. An http(s) base points at a studio served some other
 * way (`npm run dev` in a checkout), whose links hold programs up to 60,000 characters.
 */
import { APP_LINK_BASE, appLink, MAX_APP_LINK_LENGTH } from '../../../src/studio/desktop/bridge'
import { MAX_SHARED_SOURCE_LENGTH, shareFragment } from '../../../src/studio/lib/share'

export { APP_LINK_BASE }

export type StudioLink =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly error: string }

export const STUDIO_URL_ERROR =
  'hindsight.studioUrl must be hindsight://open (the Hindsight app) or an http(s) URL.'

function count(n: number): string {
  return n.toLocaleString('en-US')
}

/** The link that opens the program with the pen's step, or why the program cannot be linked. */
export function studioLink(
  source: string,
  step: number | null,
  base: string = APP_LINK_BASE,
): StudioLink {
  const page = base.trim().replace(/#.*$/, '')
  if (/^hindsight:\/\/open\/?$/i.test(page)) return desktopLink(source, step)
  if (/^https?:\/\/[^/?#\s]+/i.test(page)) return pageLink(source, step, page)
  return { ok: false, error: STUDIO_URL_ERROR }
}

function desktopLink(source: string, step: number | null): StudioLink {
  const url = appLink(source, step)
  if (url !== null) return { ok: true, url }
  return {
    ok: false,
    error: `This program is too long for a link to the Hindsight app (links hold up to ${count(MAX_APP_LINK_LENGTH)} characters). Open its file in the app instead, with File > Open.`,
  }
}

function pageLink(source: string, step: number | null, page: string): StudioLink {
  const fragment = shareFragment(source, step)
  if (fragment === null)
    return {
      ok: false,
      error: `This program is too long for a studio link (links hold up to ${count(MAX_SHARED_SOURCE_LENGTH)} characters). Save a trace with \`hindsight record\` and open it in the studio instead.`,
    }
  // A bare origin gets its root path, as the studio's own links have.
  const root = /^https?:\/\/[^/?]+$/i.test(page) ? `${page}/` : page
  return { ok: true, url: `${root}${fragment}` }
}
