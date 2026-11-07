/**
 * `hindsight debug` as installed: the bundled command reading its answers from a pipe, line by
 * line, the way a script drives it.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const AVERAGE = `fn total(xs) {
  var sum = 0
  for x in xs {
    sum += x
  }
  sum
}
fn average(xs) {
  total(xs) / (len(xs) - 1)
}
print(average([88, 83, 79]))
`

let dir = ''
let bundle = ''
let program = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hindsight-debug-'))
  bundle = join(dir, 'hindsight.mjs')
  program = join(dir, 'average.sight')
  writeFileSync(program, AVERAGE)
  await build({
    entryPoints: [fileURLToPath(new URL('./main.ts', import.meta.url))],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  })
}, 60_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function debug(input: string) {
  return spawnSync(process.execPath, [bundle, 'debug', program], { input, encoding: 'utf8' })
}

describe('hindsight debug with piped answers', () => {
  test('reaches the verdict and exits with 0', () => {
    const result = debug('w\nr\n')
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Question 2: total(xs = [88, 83, 79]) returned 250')
    expect(result.stdout).toContain('Found it: the bug is in average (lines 8–10).')
    expect(result.status).toBe(0)
  })

  test('stops with exit code 1 when the answers run out first', () => {
    const result = debug('w\n')
    expect(result.stderr).toContain('stopped before a verdict')
    expect(result.status).toBe(1)
  })

  test('ignores answers after the verdict', () => {
    const result = debug('w\r\nr\r\nw\r\nq\r\n')
    expect(result.stdout).toContain('Found it')
    expect(result.status).toBe(0)
  })
})
