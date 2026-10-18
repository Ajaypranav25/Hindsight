import { describe, expect, test } from 'vitest'
import type { Outcome, RunResult } from '../core/api-types'
import { compareRunWithRecording } from './compare-recording'

function limited(maxSteps: number): Outcome {
  return { kind: 'step-limit', maxSteps }
}

describe('compareRunWithRecording', () => {
  const run: RunResult = { outputs: [{ time: 2, text: 'x' }], outcome: limited(9), steps: 9 }

  test('accepts an identical recording', () => {
    expect(
      compareRunWithRecording(run, { length: 9, outcome: limited(9), outputs: run.outputs }),
    ).toEqual([])
  })

  test('reports a different step limit', () => {
    expect(
      compareRunWithRecording(run, { length: 9, outcome: limited(8), outputs: run.outputs }),
    ).toEqual(['recording outcome differs: step limit 9 versus 8'])
  })

  test('accepts matching aborted outcomes', () => {
    // Arrange
    const aborted: RunResult = { outputs: [], outcome: { kind: 'aborted' }, steps: 3 }

    // Act / Assert
    expect(
      compareRunWithRecording(aborted, { length: 3, outcome: { kind: 'aborted' }, outputs: [] }),
    ).toEqual([])
  })

  test('reports every difference at once', () => {
    // Arrange
    const recording = { length: 4, outcome: { kind: 'finished' } as const, outputs: [] }

    // Act
    const failures = compareRunWithRecording(run, recording)

    // Assert
    expect(failures).toEqual([
      'recording outputs differ: the run printed 1 times, the recording 0 times',
      'the recording has 4 steps but the run took 9',
      'recording outcome differs: run step-limit, recording finished',
    ])
  })
})
