import { describe, expect, test } from 'vitest'
import type { ForkResult, OutputDiffLine, OutputEvent, Recording, WriteTarget } from './api-types'
import { compareRecordings, diffOutputs } from './compare'
import { compileMain, recordSource, testRuntime } from './testing/recording'
import { record } from './recorder'

const TOTALS = [
  'var total = 0',
  'for i in 1..=5 {',
  '  total += i',
  '  print(total)',
  '}',
  'print("done")',
].join('\n')

const TOTAL: WriteTarget = { kind: 'global', name: 'total' }

function forked(result: ForkResult): Recording {
  if (!result.ok) throw new Error(result.error.message)
  return result.recording
}

function outputs(...texts: string[]): OutputEvent[] {
  return texts.map((text, index) => ({ time: index * 10, text }))
}

function shape(lines: readonly OutputDiffLine[]): string[] {
  const sign = { same: ' ', removed: '-', added: '+' } as const
  return lines.map((line) => `${sign[line.kind]}${line.text}`)
}

describe('compareRecordings', () => {
  test('two recordings of one run agree everywhere', () => {
    const program = compileMain(TOTALS)
    const a = record(program, testRuntime())
    const b = record(program, testRuntime())
    const comparison = compareRecordings(a, b)
    expect(comparison.divergence).toBeNull()
    expect(comparison.removed + comparison.added).toBe(0)
    expect(comparison.lines.every((line) => line.kind === 'same')).toBe(true)
  })

  test('a what-if diverges where its execution first differs, not at the edit', () => {
    const parent = recordSource(TOTALS)
    const time = parent.lineHits(3)[2]!
    const fork = forked(parent.fork(time, { target: TOTAL, value: 100 }))
    const comparison = compareRecordings(parent, fork)
    const firstDifferentWrite = fork
      .history(TOTAL, fork.length)
      .events.find((event) => event.time > time)!.time
    expect(comparison.divergence).toBe(firstDifferentWrite)
    expect(comparison.removed).toBe(3)
    expect(comparison.added).toBe(3)
    expect(shape(comparison.lines)).toEqual([
      ' 1',
      ' 3',
      '-6',
      '-10',
      '-15',
      '+103',
      '+107',
      '+112',
      ' done',
    ])
    const added = comparison.lines.find((line) => line.kind === 'added')!
    expect(added).toMatchObject({ indexA: null, indexB: 2, timeA: null })
    expect(added.timeB).toBe(fork.outputs[2]!.time)
    const same = comparison.lines.at(-1)!
    expect(same).toMatchObject({ indexA: 5, indexB: 5 })
  })

  test('an edit that changes nothing downstream does not diverge', () => {
    const parent = recordSource('var unused = 1\nvar n = 2\nprint(n)\nprint(n * 2)')
    const time = parent.lineHits(3)[0]!
    const fork = forked(parent.fork(time, { target: { kind: 'global', name: 'unused' }, value: 9 }))
    expect(compareRecordings(parent, fork).divergence).toBeNull()
  })

  test('different control flow, lengths and endings', () => {
    const source = 'var n = 3\nif n > 2 {\n  print("big")\n}\nprint(n)\nlet q = [1][n - 3]'
    const parent = recordSource(source)
    const time = parent.lineHits(2)[0]!
    const fork = forked(parent.fork(time, { target: { kind: 'global', name: 'n' }, value: 1 }))
    const comparison = compareRecordings(parent, fork)
    expect(parent.outcome.kind).toBe('finished')
    expect(fork.outcome.kind).toBe('error')
    expect(comparison.divergence).not.toBeNull()
    expect(comparison.divergence).toBeGreaterThan(time)
    expect(shape(comparison.lines)).toEqual(['-big', '-3', '+1'])
  })

  test('a run that stops early diverges where it stops', () => {
    const program = compileMain(TOTALS)
    const full = record(program, testRuntime())
    const limited = record(program, testRuntime(), { maxSteps: full.length - 1 })
    expect(compareRecordings(full, limited).divergence).toBe(full.length - 1)
    expect(compareRecordings(limited, full).divergence).toBe(full.length - 1)
  })

  test('recordings of different programs cannot be compared', () => {
    expect(() => compareRecordings(recordSource('print(1)'), recordSource('print(1)'))).toThrow(
      /same program/,
    )
  })
})

describe('diffOutputs', () => {
  test('insertions, deletions and replacements in the middle', () => {
    const a = outputs('a', 'b', 'c', 'd', 'e')
    const b = outputs('a', 'x', 'c', 'e', 'f')
    expect(shape(diffOutputs(a, b))).toEqual([' a', '-b', '+x', ' c', '-d', ' e', '+f'])
  })

  test('empty sides', () => {
    expect(shape(diffOutputs([], outputs('a')))).toEqual(['+a'])
    expect(shape(diffOutputs(outputs('a'), []))).toEqual(['-a'])
    expect(diffOutputs([], [])).toEqual([])
  })

  test('a middle too large to minimize is reported as removed, then added', () => {
    const a = outputs('same', 'a1', 'a2', 'end')
    const b = outputs('same', 'a2', 'b1', 'end')
    expect(shape(diffOutputs(a, b, 1))).toEqual([' same', '-a1', '-a2', '+a2', '+b1', ' end'])
    expect(shape(diffOutputs(a, b))).toEqual([' same', '-a1', ' a2', '+b1', ' end'])
  })
})
