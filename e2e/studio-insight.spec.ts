/** Insight features: the behaviour diff after an edit, the pen's place, the profile, contracts. */
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import {
  editorContent,
  expect,
  loadExample,
  penMovedFrom,
  penStep,
  replaceProgram,
  test,
  waitForRun,
} from './fixtures'

/** The innermost frame's function name in the call stack. */
function innermostFrame(page: Page) {
  return page
    .getByRole('list', { name: 'Call stack, innermost first' })
    .locator('.pn-frame-name')
    .first()
}

const FIBONACCI = readFileSync('examples/03-fibonacci.sight', 'utf8')

async function openFibonacci(page: Page): Promise<void> {
  await loadExample(page, 'Fibonacci mountains')
  await waitForRun(page)
}

test('an edit shows what changed since, and the pen stays in the same function', async ({
  studio: page,
}) => {
  await openFibonacci(page)
  // The example opens at the top of the tallest peak: deep inside fib.
  await expect(innermostFrame(page)).toHaveText('fib')

  await replaceProgram(page, FIBONACCI.replace('    return n\n', '    return n * 2\n'))
  await waitForRun(page)

  const strip = page.getByRole('region', { name: 'Since your edit' })
  await expect(strip).toContainText(/output −\d+ \+\d+/)
  await expect(strip).toContainText('starts in fib')
  await expect(strip).toContainText('pen kept in fib')
  await expect(innermostFrame(page)).toHaveText('fib')

  await strip.getByRole('button', { name: 'Show' }).click()
  await expect(strip.getByRole('heading', { name: 'Where the change starts' })).toBeVisible()
  const at = await penStep(page)
  await strip
    .getByRole('button', { name: /^fib\(n = / })
    .first()
    .click()
  await penMovedFrom(page, at)
  await expect(innermostFrame(page)).toHaveText('fib')
})

test('the profile panel draws the run and its table moves the pen', async ({ studio: page }) => {
  await openFibonacci(page)
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(page.getByText(/[\d,]+ steps · \d+ functions · just my code/)).toBeVisible()
  await expect(page.getByRole('img', { name: /Flame chart of/ })).toBeVisible()

  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const table = page.getByRole('table', { name: 'Functions by inclusive steps' })
  await expect(table).toContainText('fib')
  const at = await penStep(page)
  await table.getByRole('button', { name: '<top level>' }).click()
  await penMovedFrom(page, at)
  await table.getByRole('button', { name: 'fib', exact: true }).click()
  await expect(innermostFrame(page)).toHaveText('fib')
})

test('contracts suggested for a function are added to its header and hold', async ({
  studio: page,
}) => {
  await openFibonacci(page)
  // Put the cursor on `fn fib(n) {` (line 4).
  await editorContent(page).locator('.cm-line').nth(3).click()
  await page
    .getByRole('region', { name: 'Program editor' })
    .getByRole('button', { name: 'Suggest contracts for fib' })
    .click()

  const card = page.getByRole('region', { name: 'Contracts for fib' })
  await expect(card).toContainText(/What every one of its [\d,]+ calls did/, { timeout: 20_000 })
  const clauses = card.getByRole('list', { name: 'Suggested clauses' }).getByRole('checkbox')
  await expect(clauses).not.toHaveCount(0)
  await card.getByRole('button', { name: 'Add to the function' }).click()

  await expect(editorContent(page)).toContainText(/(requires|ensures) /)
  await waitForRun(page, /Finished/)
  await expect(page.getByRole('region', { name: 'Since your edit' })).toContainText(
    'behaves the same',
  )
})
