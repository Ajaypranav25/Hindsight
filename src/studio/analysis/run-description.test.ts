import { describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { fakeRecording } from '../state/testing'
import { describeRun, recreateRun, runKey } from './run-description'

const LOOP =
  'var total = 0\nfor i in 1..=10 {\n  total += i\n}\nprint(total)\nif total > 80 {\n  print("big")\n}\n'

function recordSource(source: string, maxSteps?: number): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('fixture does not compile')
  return record(compiled.program, maxSteps === undefined ? {} : { maxSteps })
}

function same(a: Recording, b: Recording): void {
  expect(b.length).toBe(a.length)
  expect(b.outcome).toEqual(a.outcome)
  expect(b.outputs).toEqual(a.outputs)
  expect([...b.depthSeries()]).toEqual([...a.depthSeries()])
}

/** The step just after global `name` was declared, where a what-if can change it. */
function afterDeclareOf(recording: Recording, name: string): number {
  const target = { kind: 'global', name } as const
  const event = recording.origin(target, recording.length)!
  return recording.history(target, event.time + 1).events[0]!.time + 1
}

const afterDeclare = (recording: Recording) => afterDeclareOf(recording, 'total')

describe('describing a run', () => {
  test('a finished run: its program, seed and the step limit it was recorded with', () => {
    // Arrange
    const recording = recordSource(LOOP, 5000)
    // Act
    const run = describeRun(recording)!
    // Assert
    expect(run).toEqual({
      source: LOOP,
      seed: 42,
      maxSteps: 5000,
      edits: [],
      length: recording.length,
      outcome: 'finished',
    })
    expect(describeRun(recording)).toBe(run)
    expect(runKey(run)).toBe(runKey({ ...run }))
  })

  test('forks of a recorded-again run stop where forks of the original do', () => {
    // Arrange: a fork that runs far longer than the original run.
    const source = 'var n = 1\nvar i = 0\nwhile i < n {\n  i += 1\n}\nprint(i)\n'
    const original = recordSource(source, 4000)
    const again = recreateRun(describeRun(original)!)
    if (!again.ok) throw new Error(again.error)
    const at = afterDeclareOf(original, 'n')
    const edit = { target: { kind: 'global', name: 'n' }, value: 10_000 } as const
    // Act
    const forkOriginal = original.fork(at, edit)
    const forkAgain = again.recording.fork(at, edit)
    // Assert
    if (!forkOriginal.ok || !forkAgain.ok) throw new Error('fork failed')
    expect(forkOriginal.recording.outcome).toEqual({ kind: 'step-limit', maxSteps: 4000 })
    same(forkOriginal.recording, forkAgain.recording)
  })

  test('a stand-in recording without its limits gets a limit just past its end', () => {
    const run = describeRun(fakeRecording({ length: 7 }))!
    expect(run.maxSteps).toBe(8)
    expect(run.seed).toBe(42)
  })

  test('a run cut off by the step limit keeps that limit', () => {
    const recording = recordSource(LOOP, 40)
    const run = describeRun(recording)!
    expect(run.outcome).toBe('step-limit')
    expect(run.maxSteps).toBe(40)
    same(recording, (recreateRun(run) as { recording: Recording }).recording)
  })

  test('an extended run is the same as one recorded with the larger limit', () => {
    const extended = recordSource(LOOP, 30).extend(20)
    const run = describeRun(extended)!
    expect(run.maxSteps).toBe(50)
    const again = recreateRun(run)
    expect(again.ok).toBe(true)
    if (again.ok) same(extended, again.recording)
  })

  test('a run the user stopped cannot be described', () => {
    expect(describeRun(fakeRecording({ length: 5, outcome: { kind: 'aborted' } }))).toBeNull()
  })
})

describe('recording a run again', () => {
  test('a fork of a fork is repeated edit by edit', () => {
    // Arrange
    const real = recordSource(LOOP)
    const at = afterDeclare(real)
    const first = real.fork(at, { target: { kind: 'global', name: 'total' }, value: 50 })
    if (!first.ok) throw new Error(first.error.message)
    const later = first.recording.outputs[0]!.time
    const second = first.recording.fork(later, {
      target: { kind: 'global', name: 'total' },
      value: 81,
    })
    if (!second.ok) throw new Error(second.error.message)
    // Act
    const run = describeRun(second.recording)!
    const again = recreateRun(run)
    // Assert
    expect(run.edits.map((edit) => edit.time)).toEqual([at, later])
    expect(again.ok).toBe(true)
    if (again.ok) {
      same(second.recording, again.recording)
      expect(again.recording.outputs.map((o) => o.text)).toEqual(['105', 'big'])
    }
  })

  test('a description that no longer matches is refused', () => {
    const run = describeRun(recordSource(LOOP))!
    expect(recreateRun({ ...run, length: run.length + 1 })).toEqual({
      ok: false,
      error: 'Recording the run again gave a different run.',
    })
    expect(recreateRun({ ...run, source: 'let = 1' })).toEqual({
      ok: false,
      error: 'The program does not compile.',
    })
    const bad = recreateRun({
      ...run,
      edits: [{ time: 3, edit: { target: { kind: 'global', name: 'nope' }, value: 1 } }],
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/^The what-if could not be repeated/)
  })
})
