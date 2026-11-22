/** Programs with tasks: swim lanes, the task list, deadlocks and the schedule picker. */
import { chart, expect, loadExample, outputLines, test, waitForRun } from './fixtures'
import type { Page } from '@playwright/test'

/** How many canvas pixels have (nearly) the color of the CSS custom property `token`. */
async function pixelsOfToken(page: Page, token: string): Promise<number> {
  return chart(page).evaluate((canvas, name) => {
    const element = canvas as HTMLCanvasElement
    const hex = getComputedStyle(element).getPropertyValue(name).trim()
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
    if (match === null) return -1
    const [r, g, b] = [match[1], match[2], match[3]].map((part) => parseInt(part!, 16))
    const ctx = element.getContext('2d')
    if (ctx === null) return -1
    const { data } = ctx.getImageData(0, 0, element.width, element.height)
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      const close =
        Math.abs(data[i]! - r!) < 10 &&
        Math.abs(data[i + 1]! - g!) < 10 &&
        Math.abs(data[i + 2]! - b!) < 10
      if (close && data[i + 3]! > 200) count++
    }
    return count
  }, token)
}

test('a deadlock draws one lane per task and says what every task waits for', async ({
  studio: page,
}) => {
  await loadExample(page, 'Dining philosophers')
  await waitForRun(page, /Runtime error/)

  await expect(page.getByText('Depth by task')).toBeVisible()
  await expect.poll(() => pixelsOfToken(page, '--lane-2')).toBeGreaterThan(20)
  await expect.poll(() => pixelsOfToken(page, '--lane-4')).toBeGreaterThan(20)

  const waits = page.getByRole('list', { name: 'What each task waits for' })
  await expect(waits.getByRole('listitem')).toHaveCount(4)
  await expect(waits.getByRole('listitem').first()).toContainText(
    /task 4 \(philosopher\) waits to receive from channel #\d+ here/,
  )
  await expect(waits).toContainText('task 1 (main) waits for task 2 (philosopher) on line 27')

  const tasks = page.getByRole('region', { name: 'Tasks' })
  await expect(tasks.getByRole('listitem')).toHaveCount(4)
  await expect(tasks.getByRole('listitem').nth(1)).toContainText('philosopher')
  await expect(tasks.getByRole('listitem').nth(1)).toContainText(/waits to receive from channel/)
})

test('the schedule picker records again under another interleaving', async ({ studio: page }) => {
  await loadExample(page, 'Bank race')
  await waitForRun(page)
  await expect(outputLines(page).first()).toContainText('alice 100, bob 100, total 200')

  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('radio', { name: 'Random' }).check()
  await expect(outputLines(page).first()).toContainText('alice 90, bob 110, total 200')

  await settings.getByRole('button', { name: 'Next seed' }).click()
  await expect(settings.getByRole('spinbutton', { name: 'Seed' })).toHaveValue('2')
  await expect(outputLines(page).first()).toContainText('alice 150, bob 90, total 240')

  await settings.getByRole('radio', { name: 'Round-robin' }).check()
  await expect(outputLines(page).first()).toContainText('alice 100, bob 100, total 200')
})
