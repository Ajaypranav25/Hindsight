/**
 * The command as installed: the bundled CLI started through the kinds of links npm creates, and
 * its behavior when a reader closes the pipe early.
 */
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { isEntryPoint } from './entry'
import { exitQuietlyOnClosedPipe } from './io'

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

let dir = ''
let bundle = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hindsight-bin-'))
  bundle = join(dir, 'hindsight.mjs')
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

/** Links `link` to `target`; false when the OS refuses (file links on Windows need a privilege). */
function tryLink(target: string, link: string, type: 'file' | 'junction'): boolean {
  try {
    symlinkSync(target, link, type)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

describe('isEntryPoint', () => {
  test('is true for the module itself', () => {
    expect(isEntryPoint(bundle, pathToFileURL(bundle).href)).toBe(true)
  })

  test('is true when the path reaches the module through a directory link', () => {
    const via = join(dir, 'via-directory-link')
    expect(tryLink(dir, via, 'junction')).toBe(true)
    expect(isEntryPoint(join(via, 'hindsight.mjs'), pathToFileURL(bundle).href)).toBe(true)
  })

  test('is false for another file, a missing path or no path', () => {
    const other = join(dir, 'other.mjs')
    writeFileSync(other, '')
    expect(isEntryPoint(other, pathToFileURL(bundle).href)).toBe(false)
    expect(isEntryPoint(join(dir, 'missing.mjs'), pathToFileURL(bundle).href)).toBe(false)
    expect(isEntryPoint(undefined, pathToFileURL(bundle).href)).toBe(false)
  })
})

describe('the built command', () => {
  test("runs when started through a link named like npm's bin link", (context) => {
    const link = join(dir, 'hindsight')
    if (!tryLink(bundle, link, 'file')) return context.skip()
    const result = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`hindsight ${PACKAGE_VERSION}\n`)
    expect(result.status).toBe(0)
  })

  test('exits quietly when the reader closes the pipe early', async () => {
    const program = join(dir, 'many.sight')
    writeFileSync(program, 'var i = 0\nwhile i < 100000 {\n  print(i)\n  i += 1\n}\n')
    const child = spawn(process.execPath, [bundle, 'run', program], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.stdout.once('data', () => child.stdout.destroy())
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(stderr).toBe('')
    expect(code).toBe(0)
  }, 30_000)

  test('a failing program keeps its exit code when the reader closes the pipe early', async () => {
    const program = join(dir, 'many-then-fail.sight')
    writeFileSync(
      program,
      'var i = 0\nwhile i < 100000 {\n  print(i)\n  i += 1\n}\nlet xs = [1]\nprint(xs[5])\n',
    )
    const child = spawn(process.execPath, [bundle, 'run', program], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stderr.resume()
    child.stdout.once('data', () => child.stdout.destroy())
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(code).toBe(1)
  }, 30_000)
})

describe('exitQuietlyOnClosedPipe', () => {
  test('exits with 0 on EPIPE and leaves other stream errors alone', () => {
    const stream = new EventEmitter()
    const exits: number[] = []
    exitQuietlyOnClosedPipe(stream, (code) => exits.push(code))
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(exits).toEqual([0])
    expect(() => stream.emit('error', new Error('disk on fire'))).toThrow('disk on fire')
  })
})
