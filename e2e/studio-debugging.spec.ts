/** Debugging flows: where a value came from, breakpoints, and editing with auto-run. */
import type { Page } from '@playwright/test'
import {
  currentLineText,
  editorContent,
  expect,
  loadExample,
  outputLines,
  penMovedFrom,
  penStep,
  replaceProgram,
  statusLine,
  test,
  transport,
  waitForRun,
} from './fixtures'

/** Clicks the breakpoint gutter beside source line `line` (1-based), as a user would. */
async function clickBreakpointGutter(page: Page, line: number) {
  const row = editorContent(page)
    .locator('.cm-line')
    .nth(line - 1)
  const gutter = page.locator('.ed-gutter-bp')
  await row.scrollIntoViewIfNeeded()
  const rowBox = (await row.boundingBox())!
  const gutterBox = (await gutter.boundingBox())!
  await page.mouse.click(gutterBox.x + gutterBox.width / 2, rowBox.y + rowBox.height / 2)
}

test('origin explains where a value was set', async ({ studio: page }) => {
  await loadExample(page, 'Bug hunt')
  await waitForRun(page, /Runtime error on line 17/)
  await expect(page.getByRole('button', { name: /Examples/ })).toContainText('Bug hunt')

  await transport(page, 'Jump to end').click()
  const end = Number(await page.getByRole('slider', { name: 'Time' }).getAttribute('aria-valuemax'))
  await expect.poll(() => penStep(page)).toBe(end)

  const variables = page.getByRole('region', { name: 'Variables' })
  await variables.getByRole('button', { name: 'Jump to where avg was set' }).click()
  const origin = await penMovedFrom(page, end)
  expect(origin).toBeLessThan(end)

  const notice = statusLine(page).getByText(/avg was (set|declared) here \(step [\d,]+\)/)
  await expect(notice).toBeVisible()
  const noticeStep = Number(((await notice.textContent()) ?? '').replace(/\D/g, ''))
  expect(Math.abs(noticeStep - origin)).toBeLessThanOrEqual(1)

  // The pen lands just after the write: avg is visible with its (wrong) value.
  const avgRow = variables.getByRole('listitem').filter({ hasText: /^avg/ }).first()
  await expect(avgRow).toContainText('68.5')
  await expect(page.locator('.ed-origin-label')).toHaveText('set here')
})

test('breakpoints: toggle in the gutter, continue between hits', async ({ studio: page }) => {
  // Line 19 of "Hello, Hindsight" is `total += n`, inside a loop over 1..=10.
  await expect(editorContent(page).locator('.cm-line').nth(18)).toHaveText(/total \+= n/)
  await clickBreakpointGutter(page, 19)
  await expect(page.locator('.ed-gutter-bp .ed-bp-on')).toHaveCount(1)

  await transport(page, 'Jump to start').click()
  await expect.poll(() => penStep(page)).toBe(0)

  await transport(page, 'Continue to the next breakpoint').click()
  const first = await penMovedFrom(page, 0)
  await expect.poll(() => currentLineText(page)).toContain('total += n')

  await page.keyboard.press('F8')
  const second = await penMovedFrom(page, first)
  expect(second).toBeGreaterThan(first)
  await expect.poll(() => currentLineText(page)).toContain('total += n')

  await transport(page, 'Continue backward to the previous breakpoint').click()
  await expect.poll(() => penStep(page)).toBe(first)

  // Clicking the gutter again removes the breakpoint.
  await clickBreakpointGutter(page, 19)
  await expect(page.locator('.ed-gutter-bp .ed-bp-on')).toHaveCount(0)
})

test('editing: a compile error shows, fixing it auto-runs', async ({ studio: page }) => {
  await replaceProgram(page, 'let x = 1\nprint(y)\n')
  await expect(statusLine(page)).toContainText(/1 error · line 2/)
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Does not compile' })).toBeVisible()

  await replaceProgram(page, 'let x = 41\nprint("answer {x + 1}")\n')
  // Auto-run records the fixed program on its own after a short pause.
  await waitForRun(page, /Finished · [\d,]+ steps · 1 line printed/)
  await expect(page.getByRole('heading', { name: 'Does not compile' })).toHaveCount(0)
  await expect(outputLines(page)).toHaveCount(1)
  await expect(outputLines(page).first()).toContainText('answer 42')
  await expect(page.getByRole('button', { name: /Examples/ })).toContainText('Your program')
})
