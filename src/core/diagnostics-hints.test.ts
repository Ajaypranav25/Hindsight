/**
 * "Did you mean" hints (SPEC §5.3, §7.9): the banded edit distance agrees with the full
 * optimal-string-alignment table, and hint search stays fast for large programs and records.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { closestName, editDistanceWithin } from './diagnostics'
import { compile, run } from './index'

/** The textbook full-table OSA distance, as a reference. */
function referenceDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1)
      }
      d[i]![j] = best
    }
  }
  return d[a.length]![b.length]!
}

/** The original unpruned search, as a reference. */
function referenceClosest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    if (candidate === name || candidate.startsWith('$')) continue
    const distance = referenceDistance(name, candidate)
    if (distance <= 2 && distance < name.length && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

const word = fc.string({ unit: fc.constantFrom('a', 'b', 'c', '$'), maxLength: 7 })

describe('editDistanceWithin', () => {
  test('known distances', () => {
    expect(editDistanceWithin('kitten', 'sitting', 3)).toBe(3)
    expect(editDistanceWithin('kitten', 'sitting', 2)).toBe(3)
    expect(editDistanceWithin('ab', 'ba', 2)).toBe(1)
    expect(editDistanceWithin('ca', 'abc', 3)).toBe(3)
    expect(editDistanceWithin('', 'ab', 2)).toBe(2)
    expect(editDistanceWithin('same', 'same', 0)).toBe(0)
  })

  test('agrees with the full table up to the limit', () => {
    fc.assert(
      fc.property(word, word, fc.integer({ min: 0, max: 4 }), (a, b, limit) => {
        const exact = referenceDistance(a, b)
        expect(editDistanceWithin(a, b, limit)).toBe(exact <= limit ? exact : limit + 1)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('closestName', () => {
  test('matches the unpruned search', () => {
    fc.assert(
      fc.property(word, fc.array(word, { maxLength: 12 }), (name, candidates) => {
        expect(closestName(name, candidates)).toBe(referenceClosest(name, candidates))
      }),
      { numRuns: 3000 },
    )
  })

  test('many functions and many undefined names compile quickly', () => {
    const lines: string[] = []
    for (let i = 0; i < 1000; i++) lines.push(`fn function_number_${i}(x) { x }`)
    for (let i = 0; i < 500; i++) lines.push(`print(function_numbr_${i}(1), undefined_thing_${i})`)
    const started = performance.now()
    const result = compile(lines.join('\n'))
    const elapsed = performance.now() - started
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.length).toBe(1000)
    expect(result.diagnostics[0]!.hint).toBe("did you mean 'function_number_0'?")
    expect(elapsed).toBeLessThan(3000)
  })

  test('a missing field of a huge record with long keys fails quickly', () => {
    const prefix = 'k'.repeat(75)
    const source = `let p = "${prefix}"
let r = {}
for i in 0..20000 { r["{p}_{i + 100000}"] = i }
print(r.${prefix}_x00000)`
    const compiled = compile(source)
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
    const started = performance.now()
    const result = run(compiled.program)
    const elapsed = performance.now() - started
    expect(result.outcome.kind).toBe('error')
    if (result.outcome.kind !== 'error') return
    expect(result.outcome.error.code).toBe('R010')
    expect(result.outcome.error.hint).toBe(`did you mean '${prefix}_100000'?`)
    expect(elapsed).toBeLessThan(3000)
  })
})

describe('R010 hints on huge records', () => {
  test('only the first 10,000 keys are considered', () => {
    const source = `let r = {}
for i in 0..10000 { r["filler{i}"] = i }
r.colour = 1
print(r.color)`
    const compiled = compile(source)
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
    const result = run(compiled.program)
    expect(result.outcome).toMatchObject({ kind: 'error', error: { code: 'R010' } })
    if (result.outcome.kind !== 'error') return
    expect(result.outcome.error.hint).toBeUndefined()
  })
})
