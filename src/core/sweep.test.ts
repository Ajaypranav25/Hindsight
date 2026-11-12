import { describe, expect, test } from 'vitest'
import { diffHeaps, heapEdges } from './heap-diff'
import { compile, record, type Recording } from './index'
import { isSweepText, MAX_SWEEP_VALUES, parseSweepValues, sweep, sweepAsync } from './sweep'

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program)
}

function values(text: string): unknown {
  const parsed = parseSweepValues(text)
  return parsed.ok ? parsed.values : parsed.error
}

describe('sweep values', () => {
  test('a range covers both ends, either way of writing it', () => {
    expect(values('1..5')).toEqual([1, 2, 3, 4, 5])
    expect(values('1..=5')).toEqual([1, 2, 3, 4, 5])
    expect(values(' 3 .. 1 ')).toEqual([3, 2, 1])
    expect((values('1..20') as number[]).length).toBe(20)
  })

  test('steps, fractions and negative ends', () => {
    expect(values('0..100 step 25')).toEqual([0, 25, 50, 75, 100])
    expect(values('0..0.3 step 0.1')).toEqual([0, 0.1, 0.2, 0.3])
    expect(values('-2..2 step 2')).toEqual([-2, 0, 2])
    expect(values('1..10 step 0')).toContain('above 0')
  })

  test('lists and single literals', () => {
    expect(values('1, 27, "a, b", true, nil')).toEqual([1, 27, 'a, b', true, null])
    expect(values('27')).toEqual([27])
    expect(values('1, oops')).toContain('name')
    expect(isSweepText('1..20')).toBe(true)
    expect(isSweepText('1, 2')).toBe(true)
    expect(isSweepText('27')).toBe(false)
    expect(isSweepText('"1, 2"')).toBe(false)
  })

  test('too many values are refused with a way out', () => {
    expect(values('1..1000')).toContain(`at most ${MAX_SWEEP_VALUES}`)
    expect(values('1..1000')).toContain('step')
    expect((values('1..1000 step 50') as number[]).length).toBe(20)
  })
})

const COLLATZ =
  'fn steps(n) {\n  var count = 0\n  var x = n\n  while x != 1 {\n' +
  '    x = if x % 2 == 0 { x / 2 } else { 3 * x + 1 }\n    count += 1\n  }\n  count\n}\n' +
  'let start = 6\nprint(steps(start))\n'

describe('sweeping a what-if', () => {
  test('forks once per value and reports how each future differs', async () => {
    const recording = recorded(COLLATZ)
    const at = recording.lineHits(11)[0]!
    const start = recording.stateAt(at).globals.find((global) => global.name === 'start')!
    const result = sweep(recording, at, start.target, [6, 7, 27])
    expect(result.failed).toEqual([])
    expect(result.runs.map((run) => run.recording.outputs[0]!.text)).toEqual(['8', '16', '111'])
    expect(result.runs[0]!.comparison.divergence).toBeNull()
    expect(result.runs[2]!.comparison.divergence).not.toBeNull()
    expect(result.runs[2]!.recording.length).toBeGreaterThan(result.runs[1]!.recording.length)
    expect(result.runs.map((run) => run.maxDepth)).toEqual([1, 1, 1])
    let progress = 0
    const sliced = await sweepAsync(recording, at, start.target, [6, 7, 27], {
      onRun: (done) => (progress = done),
    })
    expect(progress).toBe(3)
    expect(sliced.runs.map((run) => run.recording.length)).toEqual(
      result.runs.map((run) => run.recording.length),
    )
    const stopped = await sweepAsync(recording, at, start.target, [6, 7], {
      signal: { aborted: true },
    })
    expect(stopped.runs).toEqual([])
  })

  test('values that cannot be written are reported, not thrown', () => {
    const recording = recorded(COLLATZ)
    const result = sweep(recording, recording.length, { kind: 'global', name: 'start' }, [1])
    expect(result.runs).toEqual([])
    expect(result.failed).toHaveLength(1)
  })
})

describe('heap differences', () => {
  test('edges from variables and between objects', () => {
    const recording = recorded(
      'let a = {name: "a"}\nlet b = {next: a}\nlet xs = [a, b]\nprint(1)\n',
    )
    const state = recording.stateAt(recording.lineHits(4)[0]!)
    const texts = heapEdges(state).map((edge) => `${edge.from} ${edge.label}`.trim())
    expect(texts).toEqual(expect.arrayContaining(['global a', 'global b', 'global xs']))
    expect(heapEdges(state).filter((edge) => edge.label === 'next')).toHaveLength(1)
    expect(heapEdges(state).filter((edge) => edge.label.startsWith('['))).toHaveLength(2)
  })

  test('a what-if that cuts a link: one pointer removed, none added', () => {
    const source =
      'let tail = {value: 2, next: nil}\nlet head = {value: 1, next: tail}\nprint(head.next.value)\n'
    const real = recorded(source)
    const at = real.lineHits(3)[0]!
    const state = real.stateAt(at)
    const head = state.globals.find((global) => global.name === 'head')!
    if (head.value.kind !== 'ref') throw new Error('head is not an object')
    const fork = real.fork(at, {
      target: { kind: 'field', objectId: head.value.id, key: 'next' },
      value: nil(),
    })
    if (!fork.ok) throw new Error(fork.error.message)
    const diff = diffHeaps(state, fork.recording.stateAt(at + 1))
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([
      { from: `#${head.value.id}`, label: 'next', to: expect.any(Number) },
    ])
    expect(diffHeaps(state, state)).toEqual({ added: [], removed: [], onlyA: [], onlyB: [] })
  })
})

function nil(): null {
  return null
}
