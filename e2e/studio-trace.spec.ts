/** Trace files: download a what-if run as a .sighttrace file, then open it again. */
import { readFile } from 'node:fs/promises'
import { compile, record } from '../src/core/index'
import {
  editorContent,
  expect,
  outputLines,
  penStep,
  replaceProgram,
  statusLine,
  test,
  waitForRun,
} from './fixtures'

const PROGRAM = `// title: Running total
var total = 0
for n in 1..=5 {
  total += n
}
print("total {total}")
`

/** The step at which the third `total += n` starts (total is 3 there). */
function thirdIteration(): number {
  const compiled = compile(PROGRAM)
  if (!compiled.ok) throw new Error('the program does not compile')
  return record(compiled.program).lineHits(4)[2]!
}

test('trace files: download a what-if run, then open it and drop it on the editor', async ({
  page,
  consoleErrors,
}, testInfo) => {
  void consoleErrors
  const at = thirdIteration()
  await page.goto(`/#src=${Buffer.from(PROGRAM).toString('base64url')}&t=${at}`)
  await waitForRun(page)
  await expect.poll(() => penStep(page)).toBe(at)

  // A what-if, so the trace carries an edit to re-apply.
  const variables = page.getByRole('region', { name: 'Variables' })
  await variables
    .getByRole('button', { name: `What if total were different at step ${at}?` })
    .click()
  const input = variables.getByRole('textbox', { name: /What if total were/ })
  await input.fill('100')
  await input.press('Enter')
  await expect(page.getByRole('group', { name: 'What if' })).toContainText('total = 100')
  await expect(outputLines(page).first()).toContainText('total 112')

  // Download the run.
  await page.getByRole('button', { name: 'Trace files' }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /Download trace/ }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('running-total.sighttrace')
  const saved = testInfo.outputPath('running-total.sighttrace')
  await download.saveAs(saved)

  // Replace the program, then open the trace through the menu's file input.
  await page.getByRole('button', { name: 'Back to the real run' }).click()
  await replaceProgram(page, 'print("something else")\n')
  await page.getByTestId('trace-file-input').setInputFiles(saved)
  await expect(statusLine(page)).toContainText(
    `Opened “Running total” with 1 what-if edit at step ${at}.`,
  )
  await expect(page.getByRole('group', { name: 'What if' })).toContainText('total = 100')
  await expect(outputLines(page).first()).toContainText('total 112')
  await expect.poll(() => penStep(page)).toBe(at)
  await expect(editorContent(page)).toContainText('// title: Running total')

  // Dropping the same file on the editor opens it too.
  await page.getByRole('button', { name: 'Back to the real run' }).click()
  await replaceProgram(page, 'print("dropped over")\n')
  const bytes = [...(await readFile(saved))]
  const transfer = await page.evaluateHandle((data) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(data)], 'running-total.sighttrace'))
    return dt
  }, bytes)
  await editorContent(page).dispatchEvent('drop', { dataTransfer: transfer })
  await expect(page.getByRole('group', { name: 'What if' })).toContainText('total = 100')
  await expect(editorContent(page)).toContainText('// title: Running total')
  await expect.poll(() => penStep(page)).toBe(at)
})
