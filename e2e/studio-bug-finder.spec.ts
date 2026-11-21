/** Bug finder: answer questions about recorded calls until Hindsight names the buggy function. */
import { expect, loadExample, replaceProgram, test, waitForRun } from './fixtures'

const PROGRAM = `fn average(xs) {
  var total = 0
  for x in xs { total += x }
  total / (len(xs) + 1)
}
fn report(scores) {
  "average {average(scores)}"
}
print(report([90, 80, 70]))
`

test('the bug finder interviews its way to the buggy function', async ({ page }) => {
  await page.goto('/')
  await replaceProgram(page, PROGRAM)
  // The opening example also finishes; wait for this program's own run (one line printed).
  await waitForRun(page, /Finished · [\d,]+ steps · 1 line printed/)

  await page.getByRole('button', { name: 'Find the bug' }).click()
  const finder = page.locator('.bf-card')
  // The collapsed panel opens on its first question, with focus on it.
  await expect(page.getByRole('heading', { name: 'Question 1' })).toBeFocused()
  await expect(finder).toContainText('report(scores = [90, 80, 70])')
  await expect(finder).toContainText('"average 60"')

  await finder.getByRole('button', { name: 'Wrong' }).click()
  await expect(page.getByRole('heading', { name: 'Question 2' })).toBeVisible()
  await expect(finder).toContainText('average(xs = [90, 80, 70])')

  // "Show me" moves the pen to just after the call returned, while the interview stays open.
  await finder.getByRole('button', { name: 'Show me' }).click()
  await expect(page.getByRole('heading', { name: 'Question 2' })).toBeVisible()

  await finder.getByRole('button', { name: 'Wrong' }).click()
  await expect(finder).toContainText('Found it')
  await expect(finder).toContainText('average')
  await expect(page.getByRole('status').filter({ hasText: 'Found it' })).toHaveCount(1)
})

test('contracts and assertions answer every question in the Contracts example', async ({
  studio: page,
}) => {
  await loadExample(page, 'Contracts')
  await waitForRun(page, /Runtime error/)

  await page.getByRole('button', { name: 'Find the bug' }).first().click()
  const finder = page.locator('.bf-card')
  await expect(page.getByRole('heading', { name: 'Verdict' })).toBeVisible()
  await expect(finder).toContainText('Found it: the bug is in total')
  await expect(finder).toContainText('No questions for you')
  await expect(finder).toContainText('its postcondition on line 29 failed')

  // Taking back an automatic answer hands that question to the user.
  await finder.getByRole('button', { name: 'Undo' }).click()
  await expect(finder.getByRole('button', { name: 'Right' })).toBeVisible()
})
