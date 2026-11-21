import { describe, expect, test } from 'vitest'
import type { VM } from './runtime-types'
import { compileMain, freshVMAt, testRuntime } from './testing/recording'

/** A VM that ran `source` to the end. */
function finished(source: string): VM {
  const vm = freshVMAt(compileMain(source), testRuntime(), Infinity)
  expect(vm.status).toBe('finished')
  return vm
}

/** The work `source` does beyond one unit per step. */
function extraWork(source: string): number {
  const vm = finished(source)
  return vm.work - vm.time
}

const SETUP = 'let xs = list(0..1000)\nlet ys = list(0..1000)\n'

describe('work: steps plus elements allocated or visited (ARCHITECTURE §7.1.4)', () => {
  test('without allocation or scans, work equals the number of steps', () => {
    const vm = finished('var t = 0\nfor i in 0..50 { t += i }')
    expect(vm.work).toBe(vm.time)
  })

  test('allocations count their units', () => {
    expect(extraWork('let xs = list(0..1000)')).toBe(1000)
  })

  test('a sort counts its comparisons, scans count the items they visit', () => {
    const base = extraWork(`${SETUP}let r = 0`)
    // 1,000 new items plus about n·log2(n) = 1,000 · 10 comparisons.
    expect(extraWork(`${SETUP}let r = sort(xs)`) - base).toBe(1000 + 10_000)
    expect(extraWork(`${SETUP}let r = index_of(xs, 499)`) - base).toBe(500)
    expect(extraWork(`${SETUP}let r = index_of(xs, -1)`) - base).toBe(1000)
    expect(extraWork(`${SETUP}let r = contains(xs, 9)`) - base).toBe(10)
    expect(extraWork(`${SETUP}let r = min(xs)`) - base).toBe(1000)
    expect(extraWork(`${SETUP}let r = xs == ys`) - base).toBe(1000)
    expect(extraWork(`${SETUP}let r = xs != 3`) - base).toBe(0)
  })

  test('work is part of the state: a restored snapshot carries it on', () => {
    const program = compileMain(`${SETUP}let s = sort(xs)\nlet t = sort(ys)`)
    const runtime = testRuntime()
    const original = freshVMAt(program, runtime, 12)
    const snapshot = original.snapshot()
    original.runUntil(Infinity)
    const replica = runtime.createVM(program, {
      builtins: runtime.builtins,
      libraryProtos: runtime.libraryProtos,
    })
    replica.restore(snapshot)
    replica.runUntil(Infinity)
    expect(replica.work).toBe(original.work)
  })
})
