import { describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { AnalysisCancelled, localAnalysis } from './local'

const PRICE = ['let price = 30', 'let qty = 2', 'print(price * qty)', ''].join('\n')

function recordSource(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('fixture does not compile')
  return record(compiled.program)
}

describe('the main-thread fallback', () => {
  test('answers every kind of request', async () => {
    // Arrange
    const recording = recordSource(PRICE)
    const crash = recordSource('let xs = [1, 2, 3]\nprint(xs[3])\n')
    const target = { kind: 'global', name: 'qty' } as const
    // Act
    const sliced = await localAnalysis.analyze(recording, { kind: 'slice', at: 4 })
    const queried = await localAnalysis.analyze(recording, {
      kind: 'query',
      text: 'changed(price)',
      limit: 5,
    })
    const solved = await localAnalysis.analyze(recording, {
      kind: 'solve',
      goal: { kind: 'output', index: 0, text: '100' },
    })
    const repaired = await localAnalysis.analyze(crash, {
      kind: 'repair',
      request: { kind: 'crash' },
    })
    const swept = await localAnalysis.analyze(recording, {
      kind: 'sweep',
      time: recording.outputs[0]!.time - 3,
      target,
      values: [1, 5],
    })
    // Assert
    expect(sliced.kind).toBe('slice')
    expect(queried).toEqual({
      kind: 'query',
      outcome: expect.objectContaining({ ok: true }),
    })
    expect(solved.kind === 'solve' && solved.result.solutions.length).toBe(1)
    expect(repaired.kind === 'repair' && repaired.result.repairs.length).toBeGreaterThan(0)
    expect(swept.kind === 'sweep' && swept.sweep.runs.map((run) => run.value)).toEqual([1, 5])
  })

  test('stops with AnalysisCancelled once the signal is aborted', async () => {
    const recording = recordSource(PRICE)
    const crash = recordSource('let xs = [1, 2, 3]\nprint(xs[3])\n')
    const controller = new AbortController()
    const pending = [
      localAnalysis.analyze(recording, { kind: 'slice', at: 1 }, controller.signal),
      localAnalysis.analyze(recording, { kind: 'query', text: 'x', limit: 1 }, controller.signal),
      localAnalysis.analyze(
        crash,
        { kind: 'repair', request: { kind: 'crash' } },
        controller.signal,
      ),
      localAnalysis.analyze(
        recording,
        { kind: 'solve', goal: { kind: 'output', index: 0, text: '7' } },
        controller.signal,
      ),
      localAnalysis.analyze(
        recording,
        { kind: 'sweep', time: 2, target: { kind: 'global', name: 'qty' }, values: [1] },
        controller.signal,
      ),
    ]
    const outcomes = Promise.allSettled(pending)
    controller.abort()
    for (const outcome of await outcomes) {
      expect(outcome.status === 'rejected' && outcome.reason).toBeInstanceOf(AnalysisCancelled)
    }
    await expect(
      localAnalysis.analyze(recording, { kind: 'slice', at: 1 }, controller.signal),
    ).rejects.toThrow('The analysis was cancelled.')
  })
})
