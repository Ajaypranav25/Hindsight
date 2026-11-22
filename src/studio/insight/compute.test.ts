import { describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { describeRun } from '../analysis/run-description'
import type { RunDescription } from '../analysis/protocol'
import { editDiffSummary, insightJob, profileSummary } from './compute'

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

const FIB =
  'fn fib(n) {\n  if n < 2 { return n }\n  fib(n - 1) + fib(n - 2)\n}\n' +
  'fn main() {\n  print(fib(8))\n}\nmain()\n'

const DOUBLE = 'fn double(x) {\n  x * 2\n}\n' + 'for i in [1, 2, 3, 4] { print(double(i)) }\n'

describe('the profile summary', () => {
  test('lists the heaviest functions and lays out the stack paths flat', () => {
    const recording = recordSource(FIB)

    const summary = profileSummary(recording, true)

    expect(summary.steps).toBe(recording.length)
    expect(summary.justMyCode).toBe(true)
    expect(summary.functions[0]!.label).toBe('<top level>')
    expect(summary.functions.map((f) => f.label)).toContain('fib')
    expect(summary.flame[0]).toMatchObject({ label: '<top level>', depth: 0, parent: -1 })
    expect(summary.flame.find((n) => n.label === 'main')!.depth).toBe(1)
    expect(summary.lines.length).toBeGreaterThan(0)
    // Plain data: it must survive the trip to the main thread.
    expect(structuredClone(summary)).toEqual(summary)
  })
})

describe('insight jobs', () => {
  test('a profile request answers with a profile', () => {
    const result = insightJob(recordSource(FIB), { kind: 'profile', justMyCode: false })

    expect(result.kind).toBe('profile')
  })

  test('an infer request suggests contracts for the named function', () => {
    const result = insightJob(recordSource(DOUBLE), { kind: 'infer', fn: 'double' })

    if (result.kind !== 'infer') throw new Error('expected contracts')
    expect(result.result.functions.map((f) => f.name)).toEqual(['double'])
    const clauses = result.result.functions[0]!.suggestions.map((s) => s.clause)
    expect(clauses).toContain('result == 2 * x')
    expect(result.result.verified).toBe(true)
  })

  test('an infer request without a name covers every function', () => {
    const result = insightJob(recordSource(DOUBLE), { kind: 'infer', fn: null })

    if (result.kind !== 'infer') throw new Error('expected contracts')
    expect(result.result.functions.length).toBe(1)
  })

  test('a run diff compares the run before an edit with the shown one', () => {
    const before = recordSource(DOUBLE)
    const after = recordSource(DOUBLE.replace('x * 2', 'x * 3'))
    const previous = describeRun(before)!

    const result = insightJob(after, { kind: 'runDiff', previous, limit: 10 })

    if (result.kind !== 'runDiff' || result.diff === null) throw new Error('expected a diff')
    expect(result.diff.same).toBe(false)
    expect(result.diff.removed).toBe(3)
    expect(result.diff.added).toBe(3)
    expect(result.diff.origins[0]!.a.name).toBe('double')
    expect(result.diff.originsTotal).toBe(4)
  })

  test('a previous run that cannot be recorded again gives no diff', () => {
    const previous: RunDescription = {
      source: 'print(',
      seed: 42,
      maxSteps: 1000,
      edits: [],
      length: 3,
      outcome: 'finished',
    }

    const result = insightJob(recordSource(DOUBLE), { kind: 'runDiff', previous, limit: 10 })

    expect(result).toEqual({ kind: 'runDiff', diff: null })
  })

  test('a previous run described elsewhere is recorded again', () => {
    const before = recordSource(DOUBLE)
    const previous = structuredClone(describeRun(before)!)

    const result = insightJob(before, { kind: 'runDiff', previous, limit: 10 })

    if (result.kind !== 'runDiff' || result.diff === null) throw new Error('expected a diff')
    expect(result.diff.same).toBe(true)
  })
})

describe('the edit diff summary', () => {
  test('keeps only changed output lines, cut to the limit', () => {
    const before = recordSource(DOUBLE)
    const after = recordSource(DOUBLE.replace('[1, 2, 3, 4]', '[1, 2, 5, 6, 7]'))

    const diff = editDiffSummary(before, after, 3)

    expect(diff.outputLines.length).toBe(3)
    expect(diff.outputLines.every((line) => line.kind !== 'same')).toBe(true)
    expect(diff.sameOutcome).toBe(true)
    expect(diff.truncated).toBe(false)
  })
})
