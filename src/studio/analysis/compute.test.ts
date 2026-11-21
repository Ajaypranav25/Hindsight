import { describe, expect, test } from 'vitest'
import {
  compile,
  queryRecording,
  record,
  type Recording,
  solveInverse,
  sweep,
} from '../../core/index'
import { analysisJob, runJob, sliceSummary, sweepJob } from './compute'
import { MAX_CHAIN } from './protocol'

const SHIPPING =
  'var total = 50\ntotal = total + 22\nlet items = [total]\nif total > 80 {\n  print("free")\n}\n' +
  'print(total)\n'

const PRICE = ['let price = 30', 'let qty = 2', 'print(price * qty)', ''].join('\n')

function recordSource(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('fixture does not compile')
  return record(compiled.program)
}

describe('slice summaries', () => {
  test('list the lines, the steps and the causal chain newest first', () => {
    // Arrange
    const recording = recordSource(SHIPPING)
    const printed = recording.outputs[0]!.time
    // Act
    const slice = sliceSummary(recording, printed)!
    // Assert
    expect(slice.at).toBe(printed)
    expect(slice.lines).toEqual([1, 2, 7])
    expect(slice.effectLine).toBe(7)
    expect(slice.marks).toHaveLength(recording.length + 1)
    expect(slice.marks[printed]).toBe(1)
    expect(slice.steps).toBeGreaterThan(3)
    expect(slice.chain.map((link) => `${link.name} = ${link.value} · line ${link.line}`)).toEqual([
      'total = 72 · line 2',
      'total = 50 · line 1',
    ])
    expect(slice.chain[0]!.time).toBeGreaterThan(slice.chain[1]!.time)
    expect(slice.chainTotal).toBe(2)
  })

  test('name objects by their type and clip long strings', () => {
    const source =
      'let xs = [1, 2]\nlet s = "a rather long piece of text to clip"\nprint(len(xs) + len(s))\n'
    const recording = recordSource(source)
    const slice = sliceSummary(recording, recording.outputs[0]!.time)!
    expect(slice.chain.map((link) => link.value)).toEqual(['"a rather long piece o…"', 'a list'])
  })

  test('cap the chain and clamp the step', () => {
    const source = `var n = 0\nfor i in 1..=60 {\n  n = n + i\n}\nprint(n)\n`
    const recording = recordSource(source)
    const slice = sliceSummary(recording, recording.length + 50)!
    expect(slice.at).toBe(recording.length)
    expect(slice.effectLine).toBeNull()
    const printed = sliceSummary(recording, recording.outputs[0]!.time)!
    expect(printed.chain).toHaveLength(MAX_CHAIN)
    expect(printed.chainTotal).toBeGreaterThan(MAX_CHAIN)
  })
})

describe('analysis jobs', () => {
  test('a query job answers like the query itself', () => {
    const recording = recordSource(SHIPPING)
    const result = runJob(
      analysisJob(recording, { kind: 'query', text: 'changed(total)', limit: 10 }),
    )
    expect(result).toEqual({
      kind: 'query',
      outcome: queryRecording(recording, 'changed(total)', { limit: 10 }),
    })
  })

  test('a solve job pauses after every fork and finds what solveInverse finds', () => {
    // Arrange
    const recording = recordSource(PRICE)
    const goal = { kind: 'output', index: 0, text: '100' } as const
    const job = analysisJob(recording, { kind: 'solve', goal })
    // Act
    let pauses = 0
    let next = job.next()
    while (next.done !== true) {
      pauses += 1
      next = job.next()
    }
    // Assert
    expect(next.value).toEqual({ kind: 'solve', result: solveInverse(recording, goal) })
    expect(next.value.kind === 'solve' && next.value.result.forks).toBe(pauses)
    expect(pauses).toBeGreaterThan(0)
    expect(next.value.kind === 'solve' && next.value.result.solutions).toHaveLength(1)
  })

  test('a repair job previews a one-token fix of a crash', () => {
    const recording = recordSource('let xs = [1, 2, 3]\nprint(xs[3])\n')
    const result = runJob(analysisJob(recording, { kind: 'repair', request: { kind: 'crash' } }))
    expect(result.kind).toBe('repair')
    if (result.kind === 'repair') {
      expect(result.result.repairs.map((repair) => repair.after.trim())).toContain('print(xs[2])')
    }
  })

  test('a sweep job keeps each run without its recording, depths copied', () => {
    // Arrange
    const recording = recordSource(SHIPPING)
    const at = recording.outputs[0]!.time - 6
    const target = { kind: 'global', name: 'total' } as const
    // Act
    const summary = runJob(sweepJob(recording, at, target, [1, 99, 'x']))
    const direct = sweep(recording, at, target, [1, 99, 'x'])
    // Assert
    expect(summary.runs.map((run) => run.value)).toEqual(direct.runs.map((run) => run.value))
    expect(summary.runs.map((run) => run.length)).toEqual(
      direct.runs.map((run) => run.recording.length),
    )
    expect(summary.runs[0]!.depths).not.toBe(direct.runs[0]!.recording.depthSeries())
    expect([...summary.runs[1]!.depths]).toEqual([...direct.runs[1]!.recording.depthSeries()])
    expect(summary.runs[0]!.comparison).toEqual(direct.runs[0]!.comparison)
    expect(summary.failed).toEqual(direct.failed)
    const viaJob = runJob(analysisJob(recording, { kind: 'sweep', time: at, target, values: [1] }))
    expect(viaJob.kind).toBe('sweep')
  })
})
