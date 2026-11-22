import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import type { Recording } from './api-types'
import {
  compile,
  encodeTraceFile,
  encodeTraceFileSync,
  openTraceBundle,
  openTraceBundleAsync,
  openTraceFile,
  openTraceFileSync,
  record,
  recordAsync,
  traceBundle,
  type TraceBundle,
  verifyTrace,
} from './index'

const COUNTER = `var total = 0
fn add(n) {
  total += n
  total
}
for i in 1..=5 {
  print(add(i))
}
`

function recordSource(source: string, options: { maxSteps?: number; seed?: number } = {}) {
  const result = compile(source)
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return record(result.program, options)
}

function bundleOf(recording: Recording, time = 0, base?: Recording): TraceBundle {
  const result = traceBundle({ recording, base, time, hindsightVersion: '0.4.0' })
  if (!result.ok) throw new Error(result.error)
  return result.bundle
}

/** The first step at which the global `total` is written with value `value`. */
function writeOf(recording: Recording, value: number): number {
  const history = recording.history({ kind: 'global', name: 'total' }, recording.length)
  const event = history.events.find((e) => e.value === value)
  if (!event) throw new Error(`no write of ${value}`)
  return event.time + 1
}

/** A what-if chain of two edits of the global `total`. */
function twoEdits(base: Recording): Recording {
  const first = base.fork(writeOf(base, 3), {
    target: { kind: 'global', name: 'total' },
    value: 100,
  })
  if (!first.ok) throw new Error(first.error.message)
  const second = first.recording.fork(writeOf(first.recording, 107), {
    target: { kind: 'global', name: 'total' },
    value: -1,
  })
  if (!second.ok) throw new Error(second.error.message)
  return second.recording
}

describe('traceBundle', () => {
  test('describes a real run', () => {
    // Arrange
    const recording = recordSource(COUNTER, { seed: 9 })

    // Act
    const bundle = bundleOf(recording, 1e9)

    // Assert
    expect(bundle).toMatchObject({
      format: 'hindsight-trace',
      version: 1,
      hindsightVersion: '0.4.0',
      title: null,
      source: COUNTER,
      seed: 9,
      maxSteps: 2_000_000,
      edits: [],
      forkMaxSteps: null,
      time: recording.length,
      outcome: { kind: 'finished' },
      length: recording.length,
      output: ['1', '3', '6', '10', '15'],
    })
  })

  test('summarizes a runtime error with its line', () => {
    const bundle = bundleOf(recordSource('let a = 1\nprint(a / nil)\n'))
    expect(bundle.outcome).toMatchObject({ kind: 'error', code: 'R001', line: 2 })
  })

  test('keeps the what-if chain and both step limits', () => {
    // Arrange
    const base = recordSource(COUNTER)
    const fork = twoEdits(base)

    // Act
    const bundle = bundleOf(fork, 10, base)

    // Assert
    expect(bundle.edits).toEqual(fork.whatIf!.edits)
    expect(bundle.edits).toHaveLength(2)
    expect(bundle.maxSteps).toBe(2_000_000)
    expect(bundle.forkMaxSteps).toBe(2_000_000)
  })

  test('refuses programs and runs that are too large', () => {
    // Arrange
    const long = recordSource(`print(1)\n// ${'x'.repeat(200_000)}\n`)

    // Act
    const result = traceBundle({ recording: long, time: 0, hindsightVersion: '0.4.0' })

    // Assert
    expect(result).toEqual({ ok: false, error: 'the program is too long to save as a trace' })
  })
})

describe('openTraceBundle', () => {
  test('records the program again and verifies it', () => {
    // Arrange
    const recording = recordSource(COUNTER)
    const bundle = bundleOf(recording, 12)

    // Act
    const opened = openTraceBundle(bundle)

    // Assert
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.verification).toEqual({ verified: true })
    expect(opened.time).toBe(12)
    expect(opened.recording.length).toBe(recording.length)
    expect(opened.base).toBe(opened.recording)
  })

  test('re-applies a what-if chain', () => {
    // Arrange
    const base = recordSource(COUNTER)
    const fork = twoEdits(base)
    const bundle = bundleOf(fork, 40, base)

    // Act
    const opened = openTraceBundle(bundle)

    // Assert
    if (!opened.ok) throw new Error(opened.error)
    expect(opened.verification).toEqual({ verified: true })
    expect(opened.base.whatIf).toBeNull()
    expect(opened.base.length).toBe(base.length)
    expect(opened.recording.whatIf?.edits).toEqual(fork.whatIf!.edits)
    expect(opened.recording.outputs.map((o) => o.text)).toEqual(fork.outputs.map((o) => o.text))
  })

  test('replays step-limited, extended and aborted runs', async () => {
    // Arrange
    const limited = recordSource('var i = 0\nwhile true { i += 1 }\n', { maxSteps: 120 })
    const extended = limited.extend(80)
    const compiled = compile('var i = 0\nwhile true { i += 1 }\n')
    if (!compiled.ok) throw new Error('compile')
    const signal = { aborted: false }
    const aborted = await recordAsync(compiled.program, {
      signal,
      sliceMs: 1,
      onProgress: (time) => {
        if (time > 1000) signal.aborted = true
      },
    })

    // Act
    const results = [limited, extended, aborted].map((r) => openTraceBundle(bundleOf(r)))

    // Assert
    expect(aborted.outcome.kind).toBe('aborted')
    expect(bundleOf(extended).maxSteps).toBe(200)
    expect(bundleOf(aborted).maxSteps).toBe(aborted.length)
    for (const result of results) {
      expect(result.ok && result.verification).toEqual({ verified: true })
    }
  })

  test('reports where a replay differs from the saved run', () => {
    // Arrange: the saved fingerprint belongs to a program that printed a different value.
    const saved = recordSource('let a = 2\nprint(a * 3)\n')
    const bundle = { ...bundleOf(saved), source: 'let a = 2\nprint(a + 3)\n' }

    // Act
    const opened = openTraceBundle(bundle)

    // Assert
    if (!opened.ok) throw new Error(opened.error)
    expect(opened.verification.verified).toBe(false)
    if (opened.verification.verified) return
    const window = opened.verification.firstDifference!
    expect(window.to - window.from).toBe(1)
    expect(saved.locationAt(window.from)?.opName).toBe('Mul')
    expect(opened.verification.message).toMatch(
      new RegExp(`with Hindsight 0.4.0\\): it differs from step ${window.from}\\.`),
    )
  })

  test('says which edit could not be applied when the run changed', () => {
    // Arrange
    const base = recordSource(COUNTER)
    const bundle: TraceBundle = {
      ...bundleOf(twoEdits(base), 0, base),
      source: COUNTER.replace('var total = 0', 'var total = 0\nvar other = 1'),
    }
    const broken: TraceBundle = {
      ...bundle,
      edits: [{ time: 3, edit: { target: { kind: 'global', name: 'missing' }, value: 1 } }],
    }

    // Act
    const opened = openTraceBundle(broken)

    // Assert
    if (!opened.ok) throw new Error(opened.error)
    expect(opened.recording).toBe(opened.base)
    expect(opened.verification).toMatchObject({
      verified: false,
      firstDifference: null,
      message: expect.stringMatching(/what-if edit 1 of 1 could not be applied again \(global/),
    })
  })

  test('fails cleanly when the program does not compile', () => {
    const bundle = { ...bundleOf(recordSource(COUNTER)), source: 'print(missing)\n' }
    expect(openTraceBundle(bundle)).toMatchObject({
      ok: false,
      code: 'compile',
      error: expect.stringMatching(/does not compile: E020/),
    })
  })

  test('verifyTrace accepts a recording made from the bundle', () => {
    const recording = recordSource(COUNTER)
    expect(verifyTrace(bundleOf(recording), recordSource(COUNTER))).toEqual({ verified: true })
  })
})

describe('openTraceBundleAsync', () => {
  test('replays in slices and re-applies the edits', async () => {
    // Arrange
    const base = recordSource(COUNTER)
    const bundle = bundleOf(twoEdits(base), 30, base)
    const progress: number[] = []

    // Act
    const opened = await openTraceBundleAsync(bundle, { onProgress: (t) => progress.push(t) })

    // Assert
    expect(opened.ok && opened.verification).toEqual({ verified: true })
    expect(opened.ok && opened.recording.whatIf?.edits).toHaveLength(2)
    expect(progress.length).toBeGreaterThan(0)
  })

  test('stops when the signal is set', async () => {
    const bundle = bundleOf(recordSource(COUNTER))
    const opened = await openTraceBundleAsync(bundle, { signal: { aborted: true } })
    expect(opened).toMatchObject({ ok: false, code: 'aborted' })
  })

  test('stops between edits when the signal is set', async () => {
    // Arrange
    const base = recordSource(COUNTER)
    const bundle = bundleOf(twoEdits(base), 0, base)
    const signal = { aborted: false }

    // Act
    const opened = await openTraceBundleAsync(bundle, {
      signal,
      onProgress: (t) => {
        if (t > base.length / 2) signal.aborted = true
      },
    })

    // Assert
    expect(opened).toMatchObject({ ok: false, code: 'aborted' })
  })

  test('fails cleanly when the program does not compile', async () => {
    const bundle = { ...bundleOf(recordSource(COUNTER)), source: 'let = 1\n' }
    expect(await openTraceBundleAsync(bundle)).toMatchObject({ ok: false, code: 'compile' })
  })
})

describe('openTraceFile', () => {
  test('decodes and opens a compressed file in the browser way and the CLI way', async () => {
    // Arrange
    const recording = recordSource(COUNTER)
    const bundle = bundleOf(recording, 7)
    const browser = await encodeTraceFile(bundle)
    const cli = encodeTraceFileSync(bundle, (bytes) => gzipSync(bytes))
    if (!browser.ok || !cli.ok) throw new Error('encoding failed')

    // Act
    const async = await openTraceFile(cli.bytes)
    const sync = openTraceFileSync(browser.bytes, (bytes, max) =>
      gunzipSync(bytes, { maxOutputLength: max }),
    )

    // Assert
    for (const opened of [async, sync]) {
      expect(opened.ok).toBe(true)
      if (!opened.ok) continue
      expect(opened.bundle).toEqual(bundle)
      expect(opened.verification).toEqual({ verified: true })
      expect(opened.time).toBe(7)
    }
  })

  test('reports a damaged file as a format error', async () => {
    const junk = new Uint8Array([1, 2, 3])
    expect(openTraceFileSync(junk)).toMatchObject({ ok: false, code: 'format' })
    expect(await openTraceFile(junk)).toMatchObject({ ok: false, code: 'format' })
  })
})
