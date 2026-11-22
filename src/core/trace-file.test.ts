import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { compile, record } from './index'
import {
  type ByteCodec,
  decodeTraceFile,
  decodeTraceFileSync,
  encodeTraceFile,
  encodeTraceFileSync,
  hasStreamCompression,
  MAX_TRACE_FILE_BYTES,
  MAX_TRACE_PAYLOAD_BYTES,
  type TraceBundle,
  validateBundle,
} from './trace-file'
import { traceBundle } from './trace-open'

const gzip: ByteCodec = (bytes) => gzipSync(bytes)
const gunzip: ByteCodec = (bytes, maxBytes) => gunzipSync(bytes, { maxOutputLength: maxBytes })

function sampleBundle(source = 'var total = 0\nfor i in 0..4 { total += i }\nprint(total)\n') {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('does not compile')
  const result = traceBundle({
    recording: record(compiled.program),
    time: 5,
    hindsightVersion: '0.4.0',
    title: 'sample',
  })
  if (!result.ok) throw new Error(result.error)
  return result.bundle
}

/** The payload JSON of an uncompressed file, as a plain object to tamper with. */
function payloadOf(bundle: TraceBundle): Record<string, unknown> {
  const encoded = encodeTraceFileSync(bundle)
  if (!encoded.ok) throw new Error(encoded.error)
  return JSON.parse(new TextDecoder().decode(encoded.bytes.subarray(11))) as Record<string, unknown>
}

/** A file holding `json` (any text) as its payload. */
function fileWith(json: string, flags = 0, version = 1): Uint8Array {
  const payload = new TextEncoder().encode(json)
  const bytes = new Uint8Array(11 + payload.length)
  bytes.set(new TextEncoder().encode('SIGHTTRC'))
  bytes[8] = version & 0xff
  bytes[9] = version >>> 8
  bytes[10] = flags
  bytes.set(payload, 11)
  return bytes
}

function errorOf(result: { ok: boolean; error?: string }): string {
  expect(result.ok).toBe(false)
  return result.error ?? ''
}

describe('trace file container', () => {
  test('round-trips a bundle without compression', () => {
    // Arrange
    const bundle = sampleBundle()

    // Act
    const encoded = encodeTraceFileSync(bundle)
    const decoded = encoded.ok ? decodeTraceFileSync(encoded.bytes) : null

    // Assert
    expect(encoded.ok && new TextDecoder().decode(encoded.bytes.subarray(0, 8))).toBe('SIGHTTRC')
    expect(encoded.ok && [...encoded.bytes.subarray(8, 11)]).toEqual([1, 0, 0])
    expect(decoded).toEqual({ ok: true, bundle })
  })

  test('round-trips a bundle with a synchronous gzip codec', () => {
    // Arrange
    const bundle = sampleBundle()

    // Act
    const encoded = encodeTraceFileSync(bundle, gzip)
    if (!encoded.ok) throw new Error(encoded.error)

    // Assert
    expect(encoded.bytes[10]).toBe(1)
    expect(decodeTraceFileSync(encoded.bytes, gunzip)).toEqual({ ok: true, bundle })
    expect(errorOf(decodeTraceFileSync(encoded.bytes))).toMatch(/compressed/)
  })

  test('compresses with the host CompressionStream when there is one', async () => {
    // Arrange
    const bundle = sampleBundle()

    // Act
    const packed = await encodeTraceFile(bundle)
    const plain = await encodeTraceFile(bundle, { compress: false })

    // Assert
    expect(hasStreamCompression()).toBe(true)
    if (!packed.ok || !plain.ok) throw new Error('encoding failed')
    expect(packed.bytes[10]).toBe(1)
    expect(plain.bytes[10]).toBe(0)
    expect(await decodeTraceFile(packed.bytes)).toEqual({ ok: true, bundle })
    expect(await decodeTraceFile(plain.bytes)).toEqual({ ok: true, bundle })
    // A file compressed by the browser opens in the CLI, and the other way round.
    expect(decodeTraceFileSync(packed.bytes, gunzip)).toEqual({ ok: true, bundle })
    const cli = encodeTraceFileSync(bundle, gzip)
    expect(cli.ok && (await decodeTraceFile(cli.bytes))).toEqual({ ok: true, bundle })
  })

  test('falls back to no compression when the host has no CompressionStream', async () => {
    // Arrange
    const saved = globalThis.CompressionStream
    // @ts-expect-error -- removing the host facility for this test
    delete globalThis.CompressionStream
    try {
      // Act
      const encoded = await encodeTraceFile(sampleBundle())

      // Assert
      expect(hasStreamCompression()).toBe(false)
      expect(encoded.ok && encoded.bytes[10]).toBe(0)
    } finally {
      globalThis.CompressionStream = saved
    }
  })

  test('rejects files that are not trace files', async () => {
    expect(errorOf(decodeTraceFileSync(new Uint8Array([1, 2, 3])))).toMatch(/not a Hindsight trace/)
    expect(errorOf(decodeTraceFileSync(new TextEncoder().encode('print("hi")\n')))).toMatch(
      /not a Hindsight trace/,
    )
    expect(errorOf(await decodeTraceFile(new Uint8Array(0)))).toMatch(/not a Hindsight trace/)
  })

  test('explains a file from a newer format version', () => {
    expect(errorOf(decodeTraceFileSync(fileWith('{}', 0, 2)))).toMatch(
      /format version 2; this Hindsight reads version 1/,
    )
    expect(errorOf(decodeTraceFileSync(fileWith('{}', 0, 0)))).toMatch(/unknown trace format/)
    expect(errorOf(decodeTraceFileSync(fileWith('{}', 6)))).toMatch(/unknown flags/)
  })

  test('rejects damaged payloads', async () => {
    expect(errorOf(decodeTraceFileSync(fileWith('{"format": ')))).toMatch(/not valid JSON/)
    const badUtf8 = fileWith('"x"')
    badUtf8[11] = 0xff
    expect(errorOf(decodeTraceFileSync(badUtf8))).toMatch(/UTF-8/)
    const fakeGzip = fileWith('not gzip at all', 1)
    expect(errorOf(decodeTraceFileSync(fakeGzip, gunzip))).toMatch(/damaged/)
    expect(errorOf(await decodeTraceFile(fakeGzip))).toMatch(/damaged/)
  })

  test('refuses files and payloads above the size limits', async () => {
    // Arrange
    const huge = new Uint8Array(MAX_TRACE_FILE_BYTES + 1)
    const zeros = gzipSync(new Uint8Array(MAX_TRACE_PAYLOAD_BYTES + 1))
    const bombFile = new Uint8Array(11 + zeros.length)
    bombFile.set(fileWith('', 1).subarray(0, 11))
    bombFile.set(zeros, 11)

    // Act / Assert
    expect(errorOf(decodeTraceFileSync(huge))).toMatch(/too large/)
    expect(errorOf(await decodeTraceFile(bombFile))).toMatch(/too large once decompressed/)
    expect(errorOf(decodeTraceFileSync(bombFile, gunzip))).toMatch(/damaged or too large/)
  })

  test('refuses to write an invalid bundle', () => {
    const bundle = { ...sampleBundle(), time: -1 }
    expect(errorOf(encodeTraceFileSync(bundle))).toMatch(/cannot save this trace: time/)
  })
})

describe('validateBundle', () => {
  test('accepts what traceBundle makes', () => {
    const bundle = sampleBundle()
    expect(validateBundle(payloadOf(bundle))).toEqual(bundle)
  })

  test.each([
    ['format', 'other', /format must be/],
    ['version', 2, /version must be 1/],
    ['hindsightVersion', '1.0; rm -rf', /hindsightVersion/],
    ['title', 42, /title must be a string/],
    ['source', 'x'.repeat(200_001), /source must be a string/],
    ['seed', 1.5, /seed must be an integer/],
    ['maxSteps', 0, /maxSteps must be an integer/],
    ['maxSteps', 10_000_001, /maxSteps must be an integer/],
    ['length', -1, /length must be an integer/],
    ['time', 1e9, /time must be an integer/],
    ['edits', {}, /edits must be a list/],
    ['forkMaxSteps', 100, /forkMaxSteps must be null/],
    ['output', ['a', 1], /output\[1\] must be a string/],
    ['fingerprint', 'md5:abc', /fingerprint must be/],
    ['outcome', { kind: 'exploded' }, /outcome.kind/],
    ['outcome', { kind: 'error', code: 'X1', message: 'm', line: 1 }, /outcome.code/],
    ['checkpoints', { stride: 2, hashes: [] }, /stride does not match/],
    ['checkpoints', { stride: 1, hashes: [] }, /hashes has the wrong length/],
  ])('rejects a bad %s', (key, value, message) => {
    // Arrange
    const payload = { ...payloadOf(sampleBundle()), [key]: value }

    // Act / Assert
    expect(validateBundle(payload)).toMatch(message)
  })

  test('rejects values that are not objects', () => {
    expect(validateBundle(null)).toMatch(/must be an object/)
    expect(validateBundle([1, 2])).toMatch(/must be an object/)
  })

  test('validates every edit and keeps them in time order', () => {
    // Arrange
    const base = payloadOf(sampleBundle())
    const edit = (time: number, target: unknown, value: unknown = 1) => ({
      time,
      edit: { target, value },
    })
    const withEdits = (edits: unknown[]) => ({ ...base, edits, forkMaxSteps: 2_000_000 })

    // Act / Assert
    expect(validateBundle(withEdits([edit(3, { kind: 'global', name: 'total' })]))).not.toBeTypeOf(
      'string',
    )
    expect(
      validateBundle(
        withEdits([
          edit(5, { kind: 'global', name: 'total' }),
          edit(3, { kind: 'global', name: 'total' }),
        ]),
      ),
    ).toMatch(/edits\[1\].time/)
    expect(validateBundle(withEdits([edit(3, { kind: 'object', objectId: 2 })]))).toMatch(
      /target.kind/,
    )
    expect(validateBundle(withEdits([edit(3, { kind: 'global', name: 'a b' })]))).toMatch(
      /variable name/,
    )
    expect(validateBundle(withEdits([edit(3, { kind: 'local', frameUid: 0, slot: 1 })]))).toMatch(
      /frameUid/,
    )
    expect(validateBundle(withEdits([edit(3, { kind: 'cell', cellId: 2 }, [1])]))).toMatch(
      /must be an object|must be nil/,
    )
    expect(
      validateBundle(withEdits([edit(3, { kind: 'cell', cellId: 2 }, { number: 'pi' })])),
    ).toMatch(/must be nil, a bool/)
    expect(validateBundle({ ...base, edits: [edit(3, { kind: 'cell', cellId: 2 })] })).toMatch(
      /forkMaxSteps/,
    )
  })

  test('round-trips edit values JSON cannot hold', () => {
    // Arrange
    const bundle: TraceBundle = {
      ...sampleBundle(),
      edits: [
        { time: 1, edit: { target: { kind: 'global', name: 'a' }, value: Number.NaN } },
        { time: 2, edit: { target: { kind: 'field', objectId: 3, key: 'k' }, value: -0 } },
        { time: 3, edit: { target: { kind: 'element', objectId: 3, index: 0 }, value: Infinity } },
        { time: 4, edit: { target: { kind: 'cell', cellId: 9 }, value: -Infinity } },
        { time: 4, edit: { target: { kind: 'local', frameUid: 1, slot: 2 }, value: 'text' } },
      ],
      forkMaxSteps: 2_000_000,
    }

    // Act
    const encoded = encodeTraceFileSync(bundle)
    const decoded = encoded.ok ? decodeTraceFileSync(encoded.bytes) : null

    // Assert
    expect(decoded?.ok && decoded.bundle.edits.map((e) => e.edit.value)).toEqual([
      Number.NaN,
      -0,
      Infinity,
      -Infinity,
      'text',
    ])
  })

  test('keys such as __proto__ are inert', () => {
    // Arrange
    const json = JSON.stringify(payloadOf(sampleBundle())).replace(
      '{',
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},',
    )

    // Act
    const decoded = decodeTraceFileSync(fileWith(json))

    // Assert
    expect(decoded.ok).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(decoded.ok && Object.getPrototypeOf(decoded.bundle)).toBe(Object.prototype)
    expect(decoded.ok && Object.keys(decoded.bundle)).not.toContain('__proto__')
  })

  test('reads fields only from the object itself, never its prototype', () => {
    const payload = payloadOf(sampleBundle())
    const { source: _source, ...rest } = payload
    const inherited = Object.assign(Object.create({ source: 'print(1)\n' }) as object, rest)
    expect(validateBundle(inherited)).toMatch(/source must be a string/)
  })
})
