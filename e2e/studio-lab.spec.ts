/**
 * The lab in the studio: tracing what led to a console line (in the analysis worker), the inline
 * "why didn't this run?" widget, the console line menu and the query examples. With
 * E2E_SCREENSHOTS set to a folder, each test also saves a light and a dark screenshot there.
 */
import type { Page } from '@playwright/test'
import { editorContent, expect, outputLines, test, waitForRun } from './fixtures'

const PROGRAM = `var total = 50
total = total + 22
if total > 80 {
  print("free shipping")
}
print("total {total}")
print("done")
`

const SHOTS = process.env.E2E_SCREENSHOTS

/** Opens the program from a link; `dark` emulates a dark system theme. */
async function open(page: Page, dark = false) {
  if (dark) await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`/#src=${Buffer.from(PROGRAM).toString('base64url')}`)
  await waitForRun(page)
}

async function shoot(page: Page, name: string, dark: boolean) {
  if (SHOTS === undefined) return
  await page.screenshot({ path: `${SHOTS}/${name}-${dark ? 'dark' : 'light'}.png` })
}

const lineMarks = (page: Page, kind: 'cause' | 'effect' | 'guard') =>
  page.locator(`.ed-gutter-lab .ed-lab-${kind}`)

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light'

  test(`What led to this? traces a console line in the analysis worker (${theme})`, async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await open(page, dark)
    const lines = outputLines(page)
    await expect(lines.first()).toContainText('total 72')

    await lines.first().click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Output line 1' })
    await expect(menu.getByRole('menuitem')).toHaveText([
      /^Make this print…/,
      /^What led to this\?/,
      /^Go to this moment/,
      /^Copy line/,
    ])
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await shoot(page, 'console-menu', dark)
    await menu.getByRole('menuitem', { name: /What led to this\?/ }).click()

    // Lines 1, 2 and 6 led to it: causal bars on 1 and 2, the effect on 6, the rest dimmed.
    await expect(page.getByText('3 lines led to output line 1; the rest are dimmed')).toBeVisible()
    await expect(lineMarks(page, 'cause')).toHaveCount(2)
    await expect(lineMarks(page, 'effect')).toHaveCount(1)
    await expect(editorContent(page).locator('.ed-line-dim')).not.toHaveCount(0)
    const chain = page.getByRole('list', { name: 'Causal chain, newest first' })
    await expect(chain.getByRole('button').first()).toHaveText(/^total = 72 · step \d+ · line 2$/)
    await expect(lines.first()).toBeFocused()

    // The slice came from a worker: the studio started its analysis worker.
    await expect
      .poll(() => page.workers().some((worker) => /analysis/.test(worker.url())))
      .toBe(true)
    const worker = page.workers().find((candidate) => /analysis/.test(candidate.url()))!
    expect(await worker.evaluate(() => typeof self.postMessage)).toBe('function')
    await shoot(page, 'slice', dark)

    await page.getByRole('button', { name: 'Show all lines' }).click()
    await expect(lineMarks(page, 'cause')).toHaveCount(0)
    await expect(editorContent(page).locator('.ed-line-dim')).toHaveCount(0)
  })

  test(`why a line did not run opens under the line; Escape closes it (${theme})`, async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await open(page, dark)
    await page.locator('.ed-heat-idle').first().click()
    const widget = page.getByRole('group', { name: /did not run/i })
    await expect(widget).toBeVisible()
    await expect(widget).toBeFocused()
    await expect(widget).toContainText(/total > 80/)
    await expect(widget).toContainText(/false at step [\d,]+/)
    await expect(widget).toContainText(/total was 72, set at step [\d,]+ \(line 2\)/)
    // The widget sits directly under line 4, inside the editor.
    const asked = editorContent(page).locator('.cm-line').nth(3)
    const askedBox = (await asked.boundingBox())!
    const widgetBox = (await widget.boundingBox())!
    expect(widgetBox.y).toBeGreaterThanOrEqual(askedBox.y + askedBox.height - 1)
    expect(widgetBox.y).toBeLessThan(askedBox.y + askedBox.height + 8)
    await expect(lineMarks(page, 'guard')).toHaveCount(1)
    await shoot(page, 'why-not', dark)

    await widget.press('Escape')
    await expect(widget).toHaveCount(0)
    await expect(editorContent(page)).toBeFocused()
  })
}

test('Shift+F10 on a console line opens its menu, and Make this print… opens the form', async ({
  page,
  consoleErrors,
}) => {
  void consoleErrors
  await open(page)
  const line = outputLines(page).nth(1)
  await line.focus()
  await line.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Output line 2' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(line).toBeFocused()

  await line.press('Shift+F10')
  await page.keyboard.press('Enter')
  const field = page.getByLabel('Make this line print')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('done')
})

test('the query examples are written with the program and light up the timeline', async ({
  page,
  consoleErrors,
}) => {
  void consoleErrors
  await open(page)
  await page.getByRole('button', { name: 'Examples', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Example queries' })
  await expect(menu.getByRole('menuitem')).toHaveText([/^when total > 10/, /^changed\(total\)/])
  await shoot(page, 'query-examples', false)
  await menu.getByRole('menuitem', { name: /changed\(total\)/ }).click()
  await expect(page.getByRole('textbox', { name: 'Query' })).toHaveValue('changed(total)')
  await expect(page.locator('.tl-query__summary')).toHaveText('2 changes')
  await shoot(page, 'query-marks', false)
})
