/**
 * Serving the built studio over app://studio/: which file a request may read, its content type and
 * the headers every response carries. Requests are untrusted (any page script can fetch any path),
 * so only files inside the studio's own folder are ever served.
 */
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { APP_HOST, APP_SCHEME } from './origin'

/**
 * The studio's Content-Security-Policy: everything from the app itself and nothing from the
 * network. CodeMirror injects style elements, hence 'unsafe-inline' for styles (never scripts);
 * data: and blob: cover images and workers the page builds in memory.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ')

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
}

const FALLBACK_CONTENT_TYPE = 'application/octet-stream'

export function contentTypeOf(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? FALLBACK_CONTENT_TYPE
}

/** The headers of every studio response. */
export function responseHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  }
}

export type StudioFile =
  { readonly ok: true; readonly file: string } | { readonly ok: false; readonly status: 400 | 404 }

const NOT_FOUND: StudioFile = { ok: false, status: 404 }
const BAD_REQUEST: StudioFile = { ok: false, status: 400 }

/**
 * The file under `root` that `url` names, or why there is none. Directory URLs get their
 * index.html. Percent-escapes are decoded before the containment check, so `%2e%2e%2f` (and, on
 * Windows, `%5c`) cannot climb out of `root`.
 */
export function resolveStudioFile(root: string, url: string): StudioFile {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return BAD_REQUEST
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return NOT_FOUND
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return BAD_REQUEST
  }
  // NUL ends paths in system calls; a colon would name a drive or an NTFS stream on Windows, and a
  // backslash is a separator there. The studio's files have none of them in their names.
  if (/[\0:\\]/.test(path)) return BAD_REQUEST
  const folder = path === '' || path.endsWith('/')
  const file = join(root, folder ? `${path}/index.html` : path)
  const inside = relative(root, file)
  const outside = inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
  if (inside === '' || outside) return NOT_FOUND
  return { ok: true, file }
}
