import { VERSION } from './version'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import {
  compile,
  decodeTraceFileSync,
  encodeTraceFileSync,
  record,
  type Recording,
  traceBundle,
  type TraceBundle,
} from '../core/index'
import { parseArgs } from './args'
import type { CliIO } from './io'
import { main } from './main'
import { defaultTracePath } from './trace'

interface MemoryIO extends CliIO {
  readonly files: Map<string, string | Uint8Array>
  readonly out: string[]
  readonly err: string[]
}

function memoryIO(initial: Record<string, string | Uint8Array>, binary = true): MemoryIO {
  const files = new Map(Object.entries(initial))
  const out: string[] = []
  const err: string[] = []
  const get = (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error('no such file')
    return content
  }
  const io: MemoryIO = {
    files,
    out,
    err,
    color: false,
    readFile: (path) => {
      const content = get(path)
      return typeof content === 'string' ? content : new TextDecoder().decode(content)
    },
    listFiles: () => [],
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }
  if (!binary) return io
  return {
    ...io,
    readBytes: (path) => {
      const content = get(path)
      return typeof content === 'string' ? new TextEncoder().encode(content) : content
    },
    writeBytes: (path, bytes) => {
      if (path.startsWith('readonly/')) throw new Error('permission denied')
      files.set(path, bytes)
    },
  }
}

function cli(args: string[], io: MemoryIO) {
  io.out.length = 0
  io.err.length = 0
  const code = main(args, io)
  return { code, out: io.out.join(''), err: io.err.join('') }
}

const COUNTER = `var total = 0
for i in 1..=4 {
  total += i
  print("total {total}")
}
`
const CRASH = 'let xs = [1, 2]\nprint("before")\nprint(xs[5])\n'
const FOREVER = 'var n = 0\nwhile true { n += 1 }\n'

function recordSource(source: string, maxSteps?: number): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('does not compile')
  return record(compiled.program, { maxSteps })
}

function traceFile(bundle: TraceBundle): Uint8Array {
  const encoded = encodeTraceFileSync(bundle, (bytes) => gzipSync(bytes))
  if (!encoded.ok) throw new Error(encoded.error)
  return encoded.bytes
}

function bundleOf(recording: Recording, time: number, base?: Recording): TraceBundle {
  const result = traceBundle({ recording, base, time, hindsightVersion: '0.3.0', title: 't' })
  if (!result.ok) throw new Error(result.error)
  return result.bundle
}

describe('hindsight record', () => {
  test('writes FILE.sighttrace and summarizes the run', () => {
    // Arrange
    const io = memoryIO({ 'counter.sight': COUNTER })

    // Act
    const { code, out } = cli(['record', 'counter.sight'], io)

    // Assert
    expect(code).toBe(0)
    expect(out).toMatch(
      /^recorded \d+ steps \(finished, 4 output lines\) to counter\.sighttrace \(\d+ bytes\)\n$/,
    )
    const decoded = decodeTraceFileSync(io.files.get('counter.sighttrace') as Uint8Array, (b) =>
      gunzipSync(b),
    )
    expect(decoded.ok && decoded.bundle).toMatchObject({
      title: 'counter',
      hindsightVersion: VERSION,
      source: COUNTER,
      output: ['total 1', 'total 3', 'total 6', 'total 10'],
    })
  })

  test('takes -o, --out, --max-steps and --seed', () => {
    // Arrange
    const io = memoryIO({ 'loop.sight': FOREVER })

    // Act
    const short = cli(['record', 'loop.sight', '-o', 'a.sighttrace', '--max-steps', '500'], io)
    const long = cli(['record', 'loop.sight', '--out=b.sighttrace', '--seed', '3'], io)

    // Assert
    expect(short.code).toBe(0)
    expect(short.out).toContain('recorded 500 steps (stopped at the step limit, 0 output lines)')
    expect(long.code).toBe(0)
    expect(io.files.has('a.sighttrace') && io.files.has('b.sighttrace')).toBe(true)
  })

  test('records a crash: the file is the point', () => {
    const io = memoryIO({ 'crash.sight': CRASH })
    const { code, out } = cli(['record', 'crash.sight'], io)
    expect(code).toBe(0)
    expect(out).toContain('(runtime error R007, 1 output line)')
  })

  test('refuses to replace the program, and reports write and compile failures', () => {
    const io = memoryIO({ 'p.sight': COUNTER, 'bad.sight': 'print(nope)\n' })
    expect(cli(['record', 'p.sight', '-o', 'p.sight'], io)).toMatchObject({
      code: 1,
      err: expect.stringContaining('would replace the program'),
    })
    expect(cli(['record', 'p.sight', '-o', 'readonly/x.sighttrace'], io)).toMatchObject({
      code: 1,
      err: expect.stringContaining("cannot write 'readonly/x.sighttrace': permission denied"),
    })
    expect(cli(['record', 'bad.sight'], io).code).toBe(1)
    expect(cli(['record', 'p.sight', '-o', ''], io).code).toBe(2)
    expect(cli(['record', 'p.sight', '-o'], io).code).toBe(2)
  })

  test('says so when the host cannot write files', () => {
    const io = memoryIO({ 'p.sight': COUNTER }, false)
    expect(cli(['record', 'p.sight'], io)).toMatchObject({
      code: 1,
      err: expect.stringContaining('cannot be written here'),
    })
  })

  test('derives the default name from the program file', () => {
    expect(defaultTracePath('dir/prog.sight')).toBe('dir/prog.sighttrace')
    expect(defaultTracePath('PROG.SIGHT')).toBe('PROG.sighttrace')
    expect(defaultTracePath('notes.txt')).toBe('notes.txt.sighttrace')
  })
})

describe('commands that take a trace file', () => {
  test('run prints the saved run and exits like run', () => {
    // Arrange
    const io = memoryIO({
      'ok.sighttrace': traceFile(bundleOf(recordSource(COUNTER), 0)),
      'crash.sighttrace': traceFile(bundleOf(recordSource(CRASH), 0)),
      'loop.sighttrace': traceFile(bundleOf(recordSource(FOREVER, 300), 0)),
    })

    // Act
    const ok = cli(['run', 'ok.sighttrace'], io)
    const crash = cli(['run', 'crash.sighttrace'], io)
    const loop = cli(['run', 'loop.sighttrace'], io)

    // Assert
    expect(ok).toEqual({ code: 0, out: 'total 1\ntotal 3\ntotal 6\ntotal 10\n', err: '' })
    expect(crash.code).toBe(1)
    expect(crash.out).toBe('before\n')
    expect(crash.err).toContain('runtime error[R007]')
    expect(loop.code).toBe(2)
    expect(loop.err).toContain('reached the step limit of 300 steps saved in the trace')
  })

  test('replay opens at the saved step unless --at says otherwise', () => {
    // Arrange
    const recording = recordSource(COUNTER)
    const io = memoryIO({ 't.sighttrace': traceFile(bundleOf(recording, 9)) })

    // Act
    const saved = cli(['replay', 't.sighttrace'], io)
    const chosen = cli(['replay', 't.sighttrace', '--at', '3'], io)

    // Assert
    expect(saved.code).toBe(0)
    expect(saved.out).toMatch(new RegExp(`^step 9 of ${recording.length}`))
    expect(chosen.out).toMatch(/^step 3 of/)
  })

  test('why, whynot, slice and query work on the saved run', () => {
    // Arrange
    const io = memoryIO({ 't.sighttrace': traceFile(bundleOf(recordSource(COUNTER), 0)) })

    // Act / Assert
    expect(cli(['why', 't.sighttrace', '--line', '1', '--name', 'total'], io).out).toContain(
      "history of 'total'",
    )
    expect(cli(['whynot', 't.sighttrace', '--line', '3'], io).out).toContain(
      'Line 3 did run (4 times).',
    )
    expect(cli(['slice', 't.sighttrace'], io).out).toContain('led to the last output line')
    expect(cli(['query', 't.sighttrace', 'changed(total)'], io).out).toContain('5 changes')
  })

  test('a what-if trace shows the what-if run', () => {
    // Arrange
    const base = recordSource(COUNTER)
    const at = base.history({ kind: 'global', name: 'total' }, base.length).events[1]!.time + 1
    const fork = base.fork(at, { target: { kind: 'global', name: 'total' }, value: 100 })
    if (!fork.ok) throw new Error(fork.error.message)
    const io = memoryIO({ 'w.sighttrace': traceFile(bundleOf(fork.recording, at, base)) })

    // Act
    const { code, out, err } = cli(['run', 'w.sighttrace'], io)

    // Assert
    expect(code).toBe(0)
    expect(out).toBe('total 100\ntotal 102\ntotal 105\ntotal 109\n')
    expect(err).toBe('note: w.sighttrace is a what-if (1 edit); showing the what-if run\n')
  })

  test('warns when the run replays differently than when it was saved', () => {
    // Arrange
    const bundle = {
      ...bundleOf(recordSource(COUNTER), 0),
      source: COUNTER.replace('1..=4', '1..=3'),
    }
    const io = memoryIO({ 'old.sighttrace': traceFile(bundle) })

    // Act
    const { code, out, err } = cli(['run', 'old.sighttrace'], io)

    // Assert
    expect(code).toBe(0)
    expect(out).toBe('total 1\ntotal 3\ntotal 6\n')
    expect(err).toMatch(
      /^warning: old\.sighttrace: This run replays differently than when it was saved \(with Hindsight 0\.3\.0\): it differs from step \d+\.\n$/,
    )
  })

  test('reports unreadable and damaged trace files', () => {
    const io = memoryIO({ 'junk.sighttrace': 'print("not a trace")\n' })
    expect(cli(['run', 'junk.sighttrace'], io)).toMatchObject({
      code: 1,
      err: 'error: junk.sighttrace: this is not a Hindsight trace file\n',
    })
    expect(cli(['run', 'missing.sighttrace'], io)).toMatchObject({
      code: 1,
      err: expect.stringContaining("cannot read 'missing.sighttrace'"),
    })
    const plain = memoryIO({ 'junk.sighttrace': 'x' }, false)
    expect(cli(['run', 'junk.sighttrace'], plain).err).toContain('cannot be read here')
  })
})

describe('trace file arguments', () => {
  test('parse record with its options', () => {
    expect(parseArgs(['record', 'p.sight', '-o', 'x.sighttrace'])).toEqual({
      ok: true,
      command: {
        kind: 'record',
        file: 'p.sight',
        out: 'x.sighttrace',
        maxSteps: 2_000_000,
        seed: 42,
      },
    })
    expect(parseArgs(['record', 'p.sight'])).toMatchObject({ ok: true, command: { out: null } })
    expect(parseArgs(['record'])).toEqual({ ok: false, error: "'record' needs a FILE" })
  })

  test('replay needs --at only for programs', () => {
    expect(parseArgs(['replay', 't.sighttrace'])).toMatchObject({ ok: true, command: { at: null } })
    expect(parseArgs(['replay', 'p.sight'])).toEqual({ ok: false, error: "'replay' needs --at T" })
  })

  test('reject trace files where they do not fit', () => {
    expect(parseArgs(['whatif', 't.sighttrace', '--at', '1', '--set', 'x=1'])).toMatchObject({
      ok: false,
      error: expect.stringContaining("'whatif' takes a .sight program, not a trace file"),
    })
    expect(parseArgs(['run', 't.SightTrace', '--seed', '1'])).toEqual({
      ok: false,
      error: 'a trace file brings its own step limit and seed: drop --seed',
    })
    expect(parseArgs(['record', 't.sighttrace'])).toMatchObject({ ok: false })
  })
})
