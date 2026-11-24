/**
 * The app:// scheme the studio is served from. It must be registered as privileged before the app
 * is ready (standard: a real origin with storage; secure: a secure context, which the clipboard API
 * needs; fetch and streams: the page loads its modules and worker through it).
 */
import { readFile } from 'node:fs/promises'
import { protocol } from 'electron'
import { APP_SCHEME } from '../origin'
import { contentTypeOf, resolveStudioFile, responseHeaders } from '../static-files'

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

function errorResponse(status: number): Response {
  return new Response(null, { status, headers: responseHeaders('text/plain; charset=utf-8') })
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR'
}

/** Serves the files under `root` (the built studio) at app://studio/. Call once the app is ready. */
export function serveStudio(root: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405)
    const resolved = resolveStudioFile(root, request.url)
    if (!resolved.ok) return errorResponse(resolved.status)
    try {
      const body = await readFile(resolved.file)
      const headers = responseHeaders(contentTypeOf(resolved.file))
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), { headers })
    } catch (error) {
      if (isMissing(error)) return errorResponse(404)
      console.error(`Could not read ${resolved.file}:`, error)
      return errorResponse(500)
    }
  })
}
