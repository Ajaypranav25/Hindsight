/** The studio inside the app: it loads from app://studio, runs, and stays off the network. */
import { expect, test } from '@playwright/test'
import { replaceProgram, waitForRun } from '../../e2e/fixtures'
import { CONTENT_SECURITY_POLICY } from '../src/static-files'
import {
  closeApp,
  collectErrors,
  launchApp,
  STUDIO_CONNECTED,
  waitForStudio,
  type DesktopApp,
} from './app'

let desktop: DesktopApp

test.beforeEach(async () => {
  desktop = await launchApp()
})

test.afterEach(async () => {
  await closeApp(desktop)
})

test('the studio runs its program with no console errors', async () => {
  // Arrange: listen from the very first request, which a reload makes certain.
  const { page } = desktop
  const errors = collectErrors(page)
  await page.reload()

  // Act
  await waitForStudio(page)

  // Assert
  expect(page.url()).toBe('app://studio/index.html')
  expect(errors, 'page errors and console.error messages').toEqual([])
})

test('the analysis worker runs, from the app itself', async () => {
  // Arrange
  const { page } = desktop
  await waitForStudio(page)

  // Act: an edit makes the studio compare the new run with the old one in its analysis worker.
  await replaceProgram(page, 'var total = 50\ntotal = total + 22\nprint("total {total}")\n')
  await waitForRun(page, /Finished/)

  // Assert: the worker's module came from app://studio and runs.
  const isAnalysis = (url: string) => /^app:\/\/studio\/assets\/analysis\.worker-.*\.js$/.test(url)
  await expect.poll(() => page.workers().some((worker) => isAnalysis(worker.url()))).toBe(true)
  const worker = page.workers().find((candidate) => isAnalysis(candidate.url()))!
  expect(await worker.evaluate(() => typeof self.postMessage)).toBe('function')
})

test('the Content-Security-Policy keeps the page off the network', async () => {
  // Arrange
  const { page } = desktop
  await waitForStudio(page)

  // Act
  const result = await page.evaluate(async () => {
    const violations: string[] = []
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(event.effectiveDirective),
    )
    const outside = await fetch('https://example.com/').then(
      () => 'loaded',
      () => 'blocked',
    )
    const own = await fetch('/index.html')
    const escape = await fetch('/..%2f..%2fpackage.json')
    await new Promise((settle) => setTimeout(settle, 200))
    return {
      outside,
      violations,
      policy: own.headers.get('content-security-policy'),
      type: own.headers.get('content-type'),
      escape: escape.status,
    }
  })

  // Assert
  expect(result.outside).toBe('blocked')
  expect(result.violations).toContain('connect-src')
  expect(result.policy).toBe(CONTENT_SECURITY_POLICY)
  expect(result.type).toBe('text/html; charset=utf-8')
  expect(result.escape).toBe(404)
})

test('the page has no Node.js and no permissions but the clipboard', async () => {
  // Arrange
  const { page } = desktop
  await waitForStudio(page)

  // Act
  const result = await page.evaluate(async () => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    clipboardWrite: (
      await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })
    ).state,
    clipboardRead: (await navigator.permissions.query({ name: 'clipboard-read' as PermissionName }))
      .state,
    geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
    notifications: await Notification.requestPermission(),
  }))

  // Assert
  expect(result).toEqual({
    require: 'undefined',
    process: 'undefined',
    clipboardWrite: 'granted',
    clipboardRead: 'denied',
    geolocation: 'denied',
    notifications: 'denied',
  })
})

test('Copy link puts a link to the program on the clipboard', async () => {
  // Arrange: the clipboard takes writes only from a page whose window has the focus.
  const { app, page } = desktop
  await waitForStudio(page)
  await replaceProgram(page, 'print("copied")\n')
  await waitForRun(page, /Finished/)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus())
  const focused = await page.evaluate(() => document.hasFocus())
  test.skip(!focused, 'the window could not take the focus (a display without a window manager)')

  // Act
  await page.getByRole('button', { name: 'Copy a link to this program' }).click()

  // Assert: copied straight to the clipboard, not offered for copying by hand.
  await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible()
  const link = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(link).toMatch(/#src=[\w-]+/)
  if (STUDIO_CONNECTED) expect(link).toMatch(/^hindsight:\/\/open\/#src=/)
})
