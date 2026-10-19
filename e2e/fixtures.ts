/**
 * Shared Playwright fixtures and page helpers for the studio's end-to-end tests.
 *
 * Every test starts from a clean slate: an init script clears localStorage before the app boots,
 * so the studio opens on the first gallery example. Page errors and console.error messages are
 * collected for the whole test and asserted empty at the end.
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test'

export { expect }

interface StudioFixtures {
  /** Uncaught page errors and console.error messages seen during the test. */
  readonly consoleErrors: string[]
  /** The studio page, already loaded with its first recording finished. */
  readonly studio: Page
}

export const test = base.extend<StudioFixtures>({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      try {
        window.localStorage.clear()
      } catch {
        // Storage may be unavailable; the studio works without it.
      }
    })
    await use(context)
  },
  consoleErrors: async ({ context }, use) => {
    const errors: string[] = []
    const watch = (page: Page) => {
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
      page.on('console', (message) => {
        if (message.type() !== 'error') return
        const url = message.location().url
        // The browser asks for /favicon.ico on its own; the page declares no icon.
        if (url.endsWith('/favicon.ico')) return
        errors.push(`console.error: ${message.text()}${url ? ` (${url})` : ''}`)
      })
    }
    context.pages().forEach(watch)
    context.on('page', watch)
    await use(errors)
    expect(errors, 'page errors and console.error messages').toEqual([])
  },
  studio: async ({ page, consoleErrors }, use) => {
    void consoleErrors
    await page.goto('/')
    await waitForRun(page)
    await use(page)
  },
})

/** The header's status line (or the notice that temporarily replaces it). */
export function statusLine(page: Page): Locator {
  return page.locator('.ch-status-line')
}

/** Waits until the current recording has ended, successfully or not. */
export async function waitForRun(page: Page, expected: RegExp = /Finished|Runtime error/) {
  await expect(statusLine(page)).toContainText(expected, { timeout: 20_000 })
}

/** The strip chart, which is the time slider. */
export function chart(page: Page): Locator {
  return page.getByRole('slider', { name: 'Time' })
}

/** The tape counter, labeled "Step N of M". */
export function tapeCounter(page: Page): Locator {
  return page.getByRole('group', { name: /^Step [\d,]+ of [\d,]+$/ })
}

/** The pen's step, read from the tape counter's label. */
export async function penStep(page: Page): Promise<number> {
  const label = (await tapeCounter(page).getAttribute('aria-label')) ?? ''
  const match = /^Step ([\d,]+) of/.exec(label)
  if (!match) throw new Error(`Unexpected tape counter label: ${label}`)
  return Number(match[1]!.replace(/,/g, ''))
}

/** Waits until the pen leaves `from`, then returns its new step. */
export async function penMovedFrom(page: Page, from: number): Promise<number> {
  await expect.poll(() => penStep(page)).not.toBe(from)
  return penStep(page)
}

/** A transport button by its accessible name. */
export function transport(page: Page, name: string): Locator {
  return page.getByRole('toolbar', { name: 'Time travel' }).getByRole('button', { name })
}

/** The code editor's editable content. */
export function editorContent(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Program source' })
}

/** The source line the pen's statement starts on (its tinted header line), or null. */
export async function currentLineText(page: Page): Promise<string | null> {
  const line = editorContent(page).locator('.ed-line-current').first()
  if ((await line.count()) === 0) return null
  return line.innerText()
}

/** The console's printed lines (desktop: the Console panel under the editor). */
export function outputLines(page: Page): Locator {
  return page.getByRole('list', { name: 'Program output' }).getByRole('button')
}

/** Loads a gallery example through the Examples menu. */
export async function loadExample(page: Page, title: string) {
  await page.getByRole('button', { name: /Examples/ }).click()
  await page
    .getByRole('menu', { name: 'Example programs' })
    .getByRole('menuitemradio', { name: new RegExp(`^${escapeRegExp(title)}`) })
    .click()
}

/** Replaces the whole program text, as a user selecting all and typing would. */
export async function replaceProgram(page: Page, source: string) {
  const editor = editorContent(page)
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  // insertText avoids the editor's auto-indent and bracket closing, which typing would trigger.
  await page.keyboard.insertText(source)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
