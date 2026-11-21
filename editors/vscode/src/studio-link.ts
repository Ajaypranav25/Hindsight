/**
 * "Open in Studio": a moment link (`#src=<base64url source>&t=<step>`), built with the studio's own
 * encoder so the two can never disagree. Links hold programs up to 60,000 characters.
 */
import { MAX_SHARED_SOURCE_LENGTH, shareFragment } from '../../../src/studio/lib/share'

export const DEFAULT_STUDIO_URL = 'https://hindsight-two.vercel.app'

export type StudioLink =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly error: string }

/** The studio URL with the program and the pen's step, or why the program cannot be linked. */
export function studioLink(
  source: string,
  step: number | null,
  base: string = DEFAULT_STUDIO_URL,
): StudioLink {
  const fragment = shareFragment(source, step)
  if (fragment === null)
    return {
      ok: false,
      error: `This program is too long for a studio link (links hold up to ${MAX_SHARED_SOURCE_LENGTH.toLocaleString('en-US')} characters). Save a trace with \`hindsight record\` and open it in the studio instead.`,
    }
  const page = base.trim().replace(/#.*$/, '')
  if (!/^https?:\/\/[^/?#\s]+/i.test(page))
    return { ok: false, error: 'hindsight.studioUrl must be an http(s) URL.' }
  // A bare origin gets its root path, as the studio's own links have.
  const root = /^https?:\/\/[^/?]+$/i.test(page) ? `${page}/` : page
  return { ok: true, url: `${root}${fragment}` }
}
