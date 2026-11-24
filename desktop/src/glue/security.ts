/**
 * Electron's security checklist, applied to every web page the app creates: no new windows, no
 * navigation away from the studio, no <webview>, and no permissions but the clipboard write the
 * studio's "Copy link" needs. Links to the web open in the default browser instead.
 */
import { app, shell, type Session } from 'electron'
import { externalUrl, isAllowedPermission, isAppUrl } from '../origin'

/** Opens web and mail links with the operating system; ignores every other scheme. */
export function openExternally(url: string): void {
  const target = externalUrl(url)
  if (target === null) return
  shell.openExternal(target).catch((error: unknown) => {
    console.error(`Could not open ${target}:`, error)
  })
}

/** DevTools' own pages may navigate inside DevTools; nothing else may leave the studio. */
function mayNavigate(url: string): boolean {
  return isAppUrl(url) || url.startsWith('devtools://')
}

export function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternally(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event) => {
      if (mayNavigate(event.url)) return
      event.preventDefault()
      openExternally(event.url)
    })
    contents.on('will-redirect', (event) => {
      if (!mayNavigate(event.url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

export function hardenSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(isAllowedPermission(permission, details.requestingUrl))
  })
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isAllowedPermission(permission, requestingOrigin),
  )
  session.setDevicePermissionHandler(() => false)
}
