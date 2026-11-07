/** What if: change a value at the pen, see the new future, compare it, and go back. */
import { compile, record } from '../src/core/index'
import { expect, outputLines, penStep, statusLine, test, waitForRun } from './fixtures'

const PROGRAM = `var total = 0
for n in 1..=5 {
  total += n
}
print("total {total}")
`

/** The step at which the third `total += n` starts (total is 3 there). */
function thirdIteration(): number {
  const compiled = compile(PROGRAM)
  if (!compiled.ok) throw new Error('the program does not compile')
  return record(compiled.program).lineHits(3)[2]!
}

test('what if: fork at the pen, compare with the real run, go back', async ({
  page,
  consoleErrors,
}) => {
  void consoleErrors
  const at = thirdIteration()
  // A moment link opens the program with the pen at its step.
  await page.goto(`/#src=${Buffer.from(PROGRAM).toString('base64url')}&t=${at}`)
  await waitForRun(page)
  await expect.poll(() => penStep(page)).toBe(at)
  await expect(outputLines(page).first()).toContainText('total 15')

  const variables = page.getByRole('region', { name: 'Variables' })
  const whatIfTotal = variables.getByRole('button', {
    name: `What if total were different at step ${at}?`,
  })
  await whatIfTotal.click()
  const input = variables.getByRole('textbox', { name: /What if total were/ })
  await expect(input).toHaveValue('3')
  // Escape cancels and gives focus back to the button; the keyboard opens the editor again.
  await input.press('Escape')
  await expect(whatIfTotal).toBeFocused()
  await whatIfTotal.press('Enter')
  await expect(input).toBeFocused()
  await input.fill('oops')
  await input.press('Enter')
  await expect(variables.getByText('oops is a name, not a value')).toBeVisible()
  await input.fill('100')
  await input.press('Enter')

  const banner = page.getByRole('group', { name: 'What if' })
  await expect(banner).toContainText(`What if total = 100 at step ${at}`)
  // The edit's result takes focus: the banner saying what changed.
  await expect(banner).toBeFocused()
  await expect(banner).toContainText(/diverges at step [\d,]+ · 1 of 1 output line changed/)
  await expect(statusLine(page)).toContainText(/Finished/)
  await expect(outputLines(page).first()).toContainText('total 112')
  await expect(outputLines(page).first()).toContainText('changed')
  await expect.poll(() => penStep(page)).toBe(at)

  await banner.getByRole('button', { name: 'Go to divergence' }).click()
  await expect.poll(() => penStep(page)).toBeGreaterThan(at)

  await banner.getByRole('button', { name: 'Back to the real run' }).click()
  await expect(page.getByRole('group', { name: 'What if' })).toHaveCount(0)
  await expect(page.getByRole('slider', { name: 'Time' })).toBeFocused()
  await expect(outputLines(page).first()).toContainText('total 15')
  await expect.poll(() => penStep(page)).toBe(at)
})
