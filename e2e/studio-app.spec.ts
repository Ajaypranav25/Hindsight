/** Studio-wide features: share links, the examples menu, responsive layout and themes. */
import {
  chart,
  editorContent,
  expect,
  loadExample,
  outputLines,
  replaceProgram,
  tapeCounter,
  test,
  waitForRun,
} from './fixtures'

test('Copy link carries the program to a new page', async ({ studio: page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const program = 'let n = 6 * 7\nprint("shared {n}")\n'
  await replaceProgram(page, program)
  await waitForRun(page, /Finished · [\d,]+ steps · 1 line printed/)
  await expect(outputLines(page).first()).toContainText('shared 42')

  await page.getByRole('button', { name: 'Copy a link to this program' }).click()
  const copied = page.getByRole('button', { name: 'Link copied' })
  const manual = page.getByRole('dialog', { name: 'Copy this link' })
  await expect(copied.or(manual)).toBeVisible()
  const link = (await copied.isVisible())
    ? await page.evaluate(() => navigator.clipboard.readText())
    : await manual.getByRole('textbox').inputValue()
  expect(link).toMatch(/^http:\/\/localhost:\d+\/#src=[\w-]+$/)

  const other = await context.newPage()
  await other.goto(link)
  await waitForRun(other)
  await expect(editorContent(other)).toContainText('print("shared {n}")')
  await expect(outputLines(other).first()).toContainText('shared 42')
  await expect(other.getByRole('button', { name: /Examples/ })).toContainText('Your program')

  // The link is used once: the fragment is gone and edits persist, so a reload keeps them. (The
  // fixture clears storage on every load, so the stored source is checked directly.)
  expect(new URL(other.url()).hash).toBe('')
  const stored = () => other.evaluate(() => localStorage.getItem('hindsight:source'))
  expect(await stored()).toBe(program)
  await replaceProgram(other, 'print("edited after sharing")\n')
  await expect(outputLines(other).first()).toContainText('edited after sharing')
  expect(await stored()).toBe('print("edited after sharing")\n')
})

test('the examples menu loads and records an example', async ({ studio: page }) => {
  await page.getByRole('button', { name: /Examples/ }).click()
  const menu = page.getByRole('menu', { name: 'Example programs' })
  await expect(menu.getByRole('menuitemradio')).not.toHaveCount(0)
  await expect(menu.getByRole('menuitemradio', { name: /^Hello, Hindsight/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await loadExample(page, 'Fibonacci mountains')
  await expect(page.getByRole('button', { name: /Examples/ })).toContainText('Fibonacci mountains')
  await waitForRun(page, /Finished/)
  await expect(editorContent(page)).toContainText('title: Fibonacci mountains')
  await expect(outputLines(page).filter({ hasText: 'fib(10) = 55' })).toHaveCount(1)
})

test.describe('phone layout', () => {
  test.use({ viewport: { width: 400, height: 860 } })

  test('no horizontal scroll; panels are tabs', async ({ studio: page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    await expect(editorContent(page)).toBeVisible()
    await expect(chart(page)).toBeVisible()
    const tabs = page.getByRole('tablist', { name: 'Instruments' })
    await expect(tabs.getByRole('tab')).toHaveText(['Call stack', 'Variables', 'Heap', 'Console'])
    await expect(tabs.getByRole('tab', { name: 'Variables' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await tabs.getByRole('tab', { name: 'Console' }).click()
    await expect(page.getByRole('tabpanel')).toContainText('Hello from Hindsight!')
    await tabs.getByRole('tab', { name: 'Call stack' }).click()
    await expect(tabs.getByRole('tab', { name: 'Call stack' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByRole('tabpanel')).not.toContainText('Hello from Hindsight!')

    const after = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    expect(after).toBeLessThanOrEqual(0)
  })
})

test('desktop layout shows editor, panels and strip chart together', async ({ studio: page }) => {
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(editorContent(page)).toBeInViewport()
  for (const name of ['Call stack', 'Variables', 'Heap', 'Console'])
    await expect(page.getByRole('button', { name, exact: true })).toBeInViewport()
  await expect(outputLines(page).first()).toBeInViewport()
  await expect(tapeCounter(page)).toBeInViewport()
  await expect(chart(page)).toBeInViewport({ ratio: 1 })
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - innerWidth,
    y: document.documentElement.scrollHeight - innerHeight,
  }))
  expect(overflow.x).toBeLessThanOrEqual(0)
  expect(overflow.y).toBeLessThanOrEqual(0)
})

test('Settings switches between light and dark themes', async ({ studio: page }) => {
  const html = page.locator('html')
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('radio', { name: 'Light' }).check()
  await expect(html).toHaveAttribute('data-theme', 'light')
  const light = await background()

  await settings.getByRole('radio', { name: 'Dark' }).check()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect.poll(background).not.toBe(light)

  await settings.getByRole('radio', { name: 'System' }).check()
  await expect(html).not.toHaveAttribute('data-theme', /.+/)
})
