import { describe, expect, test } from 'vitest'
import type { Recording } from './api-types'
import { compile, record } from './index'
import {
  checkpointStride,
  fingerprintRecording,
  firstDifference,
  Fnv64,
  MAX_CHECKPOINTS,
} from './trace-hash'

function recordSource(source: string, options: { maxSteps?: number; seed?: number } = {}) {
  const result = compile(source)
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return record(result.program, options)
}

/** The recording with another outcome (methods still reach the recorder's columns). */
function withOutcome(recording: Recording, outcome: Recording['outcome']): Recording {
  return Object.assign(Object.create(recording) as Recording, { outcome })
}

function bytesHash(text: string): string {
  const hash = new Fnv64()
  for (let i = 0; i < text.length; i++) hash.byte(text.charCodeAt(i))
  return hash.hex()
}

const LOOP = 'var total = 0\nfor i in 0..5 {\n  total += i\n  print(total)\n}\n'

describe('Fnv64', () => {
  test('matches the published FNV-1a 64-bit test vectors', () => {
    // Arrange / Act / Assert
    expect(bytesHash('')).toBe('cbf29ce484222325')
    expect(bytesHash('a')).toBe('af63dc4c8601ec8c')
    expect(bytesHash('foobar')).toBe('85944171f73967e8')
  })

  test('hashes integers as four little-endian bytes', () => {
    // Arrange
    const viaInt = new Fnv64()
    const viaBytes = new Fnv64()

    // Act
    viaInt.int32(0x01020304)
    for (const byte of [4, 3, 2, 1]) viaBytes.byte(byte)

    // Assert
    expect(viaInt.hex()).toBe(viaBytes.hex())
  })
})

describe('checkpointStride', () => {
  test('is one step for short runs and grows to keep at most MAX_CHECKPOINTS', () => {
    expect(checkpointStride(0)).toBe(1)
    expect(checkpointStride(MAX_CHECKPOINTS)).toBe(1)
    expect(checkpointStride(MAX_CHECKPOINTS + 1)).toBe(2)
    expect(Math.ceil(2_000_000 / checkpointStride(2_000_000))).toBeLessThanOrEqual(MAX_CHECKPOINTS)
  })
})

describe('fingerprintRecording', () => {
  test('is the same for two recordings of the same program', () => {
    // Arrange
    const a = recordSource(LOOP)
    const b = recordSource(LOOP)

    // Act
    const fa = fingerprintRecording(a)
    const fb = fingerprintRecording(b)

    // Assert
    expect(fa.fingerprint).toMatch(/^fnv1a64:[0-9a-f]{16}$/)
    expect(fa).toEqual(fb)
    expect(fa.checkpoints.hashes).toHaveLength(a.length)
  })

  test('changes with the output, the seed and the outcome', () => {
    // Arrange
    const base = fingerprintRecording(recordSource('print(random())\n')).fingerprint

    // Act
    const otherSeed = fingerprintRecording(recordSource('print(random())\n', { seed: 7 }))
    const otherText = fingerprintRecording(recordSource('print(random() + 0)\n'))
    const crash = fingerprintRecording(recordSource('print(random())\nprint(1 / nil)\n'))

    // Assert
    expect(otherSeed.fingerprint).not.toBe(base)
    expect(otherText.fingerprint).not.toBe(base)
    expect(crash.fingerprint).not.toBe(base)
  })

  test('treats a step limit and an abort at the same step alike', () => {
    // Arrange
    const limited = recordSource('while true { }\n', { maxSteps: 50 })
    const aborted = withOutcome(limited, { kind: 'aborted' })

    // Act / Assert
    expect(fingerprintRecording(aborted).fingerprint).toBe(
      fingerprintRecording(limited).fingerprint,
    )
  })

  test('falls back to the public API for recordings made elsewhere', () => {
    // Arrange
    const real = recordSource(LOOP)
    const foreign = {
      length: real.length,
      outputs: real.outputs,
      outcome: real.outcome,
      locationAt: (t: number) => real.locationAt(t),
      depthAt: (t: number) => real.depthAt(t),
    } as unknown as Recording

    // Act
    const first = fingerprintRecording(foreign)

    // Assert
    expect(fingerprintRecording(foreign)).toEqual(first)
    expect(first.checkpoints.hashes).toHaveLength(real.length)
  })
})

describe('firstDifference', () => {
  test('is null when the fingerprints agree', () => {
    const recording = recordSource(LOOP)
    const print = fingerprintRecording(recording)
    expect(firstDifference({ ...print, length: recording.length }, print, recording.length)).toBe(
      null,
    )
  })

  test('finds the exact step for short runs', () => {
    // Arrange
    const saved = recordSource('let a = 1\nlet b = 2\nprint(a + b)\n')
    const replay = recordSource('let a = 1\nlet b = 2\nprint(a - b)\n')
    // The steps agree up to the instruction the edit changed (`Add` and `Sub` share an ip).
    const expected = Array.from({ length: saved.length }, (_, t) => t).find(
      (t) => saved.locationAt(t)?.opName !== replay.locationAt(t)?.opName,
    )

    // Act
    const window = firstDifference(
      { ...fingerprintRecording(saved), length: saved.length },
      fingerprintRecording(replay, 1),
      replay.length,
    )

    // Assert
    expect(window).toEqual({ from: expected, to: expected! + 1 })
  })

  test('points at the end when one run goes on after the other stopped', () => {
    // Arrange
    const saved = recordSource('while true { }\n', { maxSteps: 40 })
    const replay = recordSource('while true { }\n', { maxSteps: 60 })

    // Act
    const window = firstDifference(
      { ...fingerprintRecording(saved), length: saved.length },
      fingerprintRecording(replay, 1),
      replay.length,
    )

    // Assert
    expect(window).toEqual({ from: 40, to: 41 })
  })

  test('points at the end when only the ending differs', () => {
    // Arrange
    const recording = recordSource('while true { }\n', { maxSteps: 40 })
    const print = fingerprintRecording(recording)
    const finished = withOutcome(recording, { kind: 'finished' })

    // Act
    const window = firstDifference(
      { ...print, length: recording.length },
      fingerprintRecording(finished, print.checkpoints.stride),
      finished.length,
    )

    // Assert
    expect(window).toEqual({ from: 40, to: 41 })
  })

  test('gives a window of checkpoint width for long runs', () => {
    // Arrange
    const saved = recordSource('var i = 0\nwhile i < 3000 { i += 1 }\nprint(i)\n')
    const replay = recordSource('var i = 0\nwhile i < 3000 { i += 1 }\nprint(i + 1)\n')
    const stride = checkpointStride(saved.length)

    // Act
    const window = firstDifference(
      { ...fingerprintRecording(saved), length: saved.length },
      fingerprintRecording(replay, stride),
      replay.length,
    )

    // Assert
    expect(stride).toBeGreaterThan(1)
    expect(window).not.toBeNull()
    expect(window!.to - window!.from).toBeLessThanOrEqual(stride)
    expect(window!.from).toBeGreaterThan(saved.length - 2 * stride)
  })
})
