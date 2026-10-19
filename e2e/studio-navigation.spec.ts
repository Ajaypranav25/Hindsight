/** Opening the studio and travelling through a recording: transport, keys, strip chart, console. */
import {
  chart,
  currentLineText,
  expect,
  outputLines,
  penMovedFrom,
  penStep,
  statusLine,
  tapeCounter,
  test,
  transport,
} from './fixtures'

test('opens on the first example, already recorded', async ({ studio: page, consoleErrors }) => {
  await expect(page).toHaveTitle(/Hindsight/)
  await expect(page.getByRole('button', { name: /Examples/ })).toContainText('Hello, Hindsight')
  await expect(statusLine(page)).toContainText(/Finished · [\d,]+ steps · 5 lines printed/)
  await expect(tapeCounter(page)).toBeVisible()
  await expect(tapeCounter(page)).toContainText(/Step/)
  await expect(chart(page)).toBeVisible()
  const length = Number(await chart(page).getAttribute('aria-valuemax'))
  expect(length).toBeGreaterThan(0)
  await expect(outputLines(page)).toHaveCount(5)
  expect(consoleErrors).toEqual([])
})

test('transport buttons and F-keys step forwards and backwards', async ({ studio: page }) => {
  await transport(page, 'Jump to start').click()
  await expect.poll(() => penStep(page)).toBe(0)
  await expect.poll(() => currentLineText(page)).toContain('let name = "Hindsight"')

  await transport(page, 'Step over').click()
  const afterOver = await penMovedFrom(page, 0)
  expect(afterOver).toBeGreaterThan(0)
  await expect.poll(() => currentLineText(page)).toContain('print("Hello from {name}!")')

  await transport(page, 'Step into').click()
  const afterInto = await penMovedFrom(page, afterOver)
  expect(afterInto).toBeGreaterThan(afterOver)

  await transport(page, 'Step back into').click()
  await expect.poll(() => penStep(page)).toBe(afterOver)

  // The same moves from the keyboard (handled globally, whatever has focus outside text fields).
  await transport(page, 'Jump to start').click()
  await expect.poll(() => penStep(page)).toBe(0)
  await page.keyboard.press('F10')
  await expect.poll(() => penStep(page)).toBe(afterOver)
  await expect.poll(() => currentLineText(page)).toContain('print("Hello from {name}!")')
  await page.keyboard.press('F11')
  await expect.poll(() => penStep(page)).toBe(afterInto)
  await page.keyboard.press('Shift+F11')
  await expect.poll(() => penStep(page)).toBe(afterOver)
  await page.keyboard.press('Shift+F10')
  await expect.poll(() => penStep(page)).toBe(0)
  await expect.poll(() => currentLineText(page)).toContain('let name = "Hindsight"')
})

test('clicking the strip chart moves the pen; arrows step it', async ({ studio: page }) => {
  const slider = chart(page)
  const box = (await slider.boundingBox())!
  // Stay in the upper part of the paper: the bottom strip is the scale, which pans instead.
  const y = box.height * 0.35

  await slider.click({ position: { x: box.width * 0.1, y } })
  const early = await penStep(page)
  await slider.click({ position: { x: box.width * 0.9, y } })
  const late = await penMovedFrom(page, early)
  expect(late).toBeGreaterThan(early)
  await expect(slider).toHaveAttribute('aria-valuenow', String(late))

  await expect(slider).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  const back = await penMovedFrom(page, late)
  expect(back).toBeLessThan(late)
  // A click can land mid-statement, so stepping back and forth need not return to the same step.
  await page.keyboard.press('ArrowRight')
  const forward = await penMovedFrom(page, back)
  expect(forward).toBeGreaterThan(back)
  await page.keyboard.press('Shift+ArrowLeft')
  const overBack = await penMovedFrom(page, forward)
  expect(overBack).toBeLessThan(forward)
})

test('console ghosts future output and seeks to a printed line', async ({ studio: page }) => {
  await transport(page, 'Jump to start').click()
  await expect.poll(() => penStep(page)).toBe(0)
  const lines = outputLines(page)
  await expect(lines).toHaveCount(5)
  for (let i = 0; i < 5; i++) await expect(lines.nth(i)).toHaveAttribute('title', /after the pen/)

  const target = lines.nth(2)
  await expect(target).toContainText('Nice to meet you, Grace!')
  const stamp = Number(((await target.getAttribute('title')) ?? '').replace(/\D/g, ''))
  await target.click()
  await expect.poll(() => penStep(page)).toBe(stamp)
  await expect(target).toHaveAttribute('aria-current', 'step')
  await expect(lines.nth(1)).not.toHaveAttribute('title', /after the pen/)
  await expect(lines.nth(3)).toHaveAttribute('title', /after the pen/)
  await expect(lines.nth(4)).toHaveAttribute('title', /after the pen/)
})
