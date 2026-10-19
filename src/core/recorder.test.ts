import { describe, expect, test, vi } from 'vitest'
import type { Recording } from './api-types'
import { builtinIndex } from './builtin-names'
import { InternalError } from './diagnostics'
import { record, recordAsync } from './recorder'
import { yieldToHost } from './recorder-async'
import type { ListObj, NativeObj, Value } from './runtime-types'
import { compileMain, recordSource, testRuntime } from './testing/recording'

const COUNTER = `var total = 0
for i in 0..400 {
  total += i
  if i % 100 == 0 {
    print(total)
  }
}
print("done")`

/** Everything observable about a recording at a few times, for equality checks. */
function fingerprint(recording: Recording, times: readonly number[]): unknown {
  return {
    length: recording.length,
    outcome: recording.outcome,
    outputs: recording.outputs,
    depths: [...recording.depthSeries()],
    states: times.map((t) => recording.stateAt(Math.min(t, recording.length))),
    origin: recording.origin({ kind: 'global', name: 'total' }, recording.length),
    history: recording.history({ kind: 'global', name: 'total' }, recording.length).total,
  }
}

describe('record: outcomes and stopping rules', () => {
  test('a finished run: outputs, length and no location at N', () => {
    const recording = recordSource(COUNTER)
    expect(recording.outcome).toEqual({ kind: 'finished' })
    expect(recording.outputs.map((o) => o.text)).toEqual(['0', '5050', '20100', '45150', 'done'])
    expect(recording.locationAt(recording.length)).toBeNull()
    expect(recording.depthSeries().length).toBe(recording.length)
    expect(recording.program.source).toBe(COUNTER)
  })

  test('output counts per time', () => {
    const recording = recordSource('print(1)\nprint(2)')
    const [first, second] = recording.outputs
    expect(recording.outputCountAt(0)).toBe(0)
    expect(recording.outputCountAt(first!.time)).toBe(0)
    expect(recording.outputCountAt(first!.time + 1)).toBe(1)
    expect(recording.outputCountAt(second!.time + 1)).toBe(2)
    expect(recording.outputCountAt(recording.length)).toBe(2)
  })

  test('step limit at maxSteps, with the paused location stored', () => {
    const recording = recordSource(COUNTER, { maxSteps: 100 })
    expect(recording.length).toBe(100)
    expect(recording.outcome).toEqual({ kind: 'step-limit', maxSteps: 100 })
    expect(recording.locationAt(100)).not.toBeNull()
    expect(recordSource(COUNTER, { maxSteps: 0 }).length).toBe(0)
  })

  test('finishing exactly at the limit is finished, not a step limit', () => {
    const steps = recordSource(COUNTER).length
    expect(recordSource(COUNTER, { maxSteps: steps }).outcome).toEqual({ kind: 'finished' })
    expect(recordSource(COUNTER, { maxSteps: steps - 1 }).outcome.kind).toBe('step-limit')
  })

  test('an error at the limit is an error', () => {
    const source = 'let x = nil\nx.y'
    const steps = recordSource(source).length
    expect(recordSource(source, { maxSteps: steps + 1 }).outcome.kind).toBe('error')
  })

  test('events, outputs and allocations of the failing step are discarded', () => {
    const runtime = testRuntime()
    const builtins = [...runtime.builtins]
    const index = builtinIndex('panic')
    const failing: NativeObj = {
      type: 'native',
      id: -(index + 1),
      name: 'panic',
      minArgs: 1,
      maxArgs: 1,
      fn: (ctx, args) => {
        ctx.print('lost')
        ctx.newList([])
        ctx.listAppend(args[0] as ListObj, 5)
        return ctx.fail('R017', 'boom')
      },
    }
    builtins[index] = failing as Value
    const program = compileMain('let xs = [1]\nprint("kept")\npanic(xs)')
    const recording = record(program, { ...runtime, builtins })
    expect(recording.outcome.kind).toBe('error')
    expect(recording.outputs.map((o) => o.text)).toEqual(['kept'])
    const xs = recording.stateAt(recording.length).globals[0]!.value
    const id = xs.kind === 'ref' ? xs.id : -1
    expect(recording.origin({ kind: 'object', objectId: id }, recording.length)?.kind).toBe('alloc')
    expect(recording.allocationTime(id + 1)).toBeNull()
    expect(recording.objectAt(recording.length, id)).toMatchObject({ length: 1 })
    const error = recording.outcome.kind === 'error' ? recording.outcome.error : null
    expect(error?.time).toBe(recording.length)
  })

  test('invalid step limits and times are internal errors', () => {
    expect(() => recordSource(COUNTER, { maxSteps: -1 })).toThrow(InternalError)
    const recording = recordSource('print(1)')
    expect(() => recording.locationAt(recording.length + 1)).toThrow(InternalError)
    expect(() => recording.depthAt(-1)).toThrow(InternalError)
    expect(() => recording.stateAt(0.5)).toThrow(InternalError)
    expect(() => recording.objectAt(Number.NaN, 1)).toThrow(InternalError)
    expect(() => recording.outputCountAt(99)).toThrow(InternalError)
  })

  test('seeks reuse cached views and replay correctly in any order', () => {
    const recording = recordSource(COUNTER, { snapshotBudget: 2 })
    const late = recording.stateAt(recording.length - 3)
    const early = recording.stateAt(5)
    expect(recording.stateAt(recording.length - 3)).toBe(late)
    expect(recordSource(COUNTER).stateAt(5)).toEqual(early)
  })
})

describe('recordAsync', () => {
  test('produces the same recording as record', async () => {
    const program = compileMain(COUNTER)
    const times = [0, 7, 500, 1200]
    const sync = record(program, testRuntime())
    const progress: number[] = []
    const asyncRecording = await recordAsync(program, testRuntime(), {
      sliceMs: 0,
      onProgress: (time) => progress.push(time),
    })
    expect(fingerprint(asyncRecording, times)).toEqual(fingerprint(sync, times))
    expect(progress.at(-1)).toBe(sync.length)
    expect(progress.length).toBeGreaterThan(1)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
  })

  test('an aborted recording pauses and can be extended to the end', async () => {
    const program = compileMain(COUNTER)
    const signal = { aborted: false }
    const recording = await recordAsync(program, testRuntime(), {
      sliceMs: 0,
      signal,
      onProgress: () => {
        signal.aborted = true
      },
    })
    expect(recording.outcome).toEqual({ kind: 'aborted' })
    expect(recording.length).toBeGreaterThan(0)
    expect(recording.locationAt(recording.length)).not.toBeNull()
    expect(recording.stateAt(recording.length).frames.length).toBeGreaterThan(0)
    const full = record(program, testRuntime())
    const resumed = recording.extend(full.length)
    expect(fingerprint(resumed, [3, 900])).toEqual(fingerprint(full, [3, 900]))
  })

  test('a signal that is already aborted records nothing', async () => {
    const recording = await recordAsync(compileMain(COUNTER), testRuntime(), {
      signal: { aborted: true },
    })
    expect(recording.length).toBe(0)
    expect(recording.outcome.kind).toBe('aborted')
  })

  test('yielding falls back to setTimeout without MessageChannel', async () => {
    vi.stubGlobal('MessageChannel', undefined)
    try {
      await expect(yieldToHost()).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('extend', () => {
  const program = compileMain(COUNTER)
  const full = record(program, testRuntime())
  const paused = record(program, testRuntime(), { maxSteps: 1000 })
  const before = fingerprint(paused, [0, 999, 1000])

  test('continues for at most the extra steps and accumulates maxSteps', () => {
    const extended = paused.extend(500)
    expect(extended.length).toBe(1500)
    expect(extended.outcome).toEqual({ kind: 'step-limit', maxSteps: 1500 })
    expect(extended.extend(0).length).toBe(1500)
  })

  test('reaching the end equals an uninterrupted recording', () => {
    const extended = paused.extend(1_000_000)
    expect(extended.outcome).toEqual({ kind: 'finished' })
    const times = [0, 999, 1000, 1001, full.length - 1, full.length]
    expect(fingerprint(extended, times)).toEqual(fingerprint(full, times))
    expect(extended.lineHits(3)).toEqual(full.lineHits(3))
  })

  test('leaves the receiver unchanged and repeated calls are independent', () => {
    const first = paused.extend(300)
    const longer = paused.extend(2000)
    const second = paused.extend(300)
    expect(fingerprint(paused, [0, 999, 1000])).toEqual(before)
    expect(fingerprint(second, [1000, 1150, 1300])).toEqual(fingerprint(first, [1000, 1150, 1300]))
    expect(longer.stateAt(1150)).toEqual(full.stateAt(1150))
    expect(first.stateAt(1299)).toEqual(full.stateAt(1299))
  })

  test('extensions of extensions', () => {
    const chained = paused.extend(100).extend(100).extend(100)
    expect(chained.length).toBe(1300)
    expect(chained.outcome).toEqual({ kind: 'step-limit', maxSteps: 1300 })
    expect(chained.stateAt(1250)).toEqual(full.stateAt(1250))
  })

  test('extendAsync', async () => {
    const extended = await paused.extendAsync(1_000_000, { sliceMs: 0 })
    expect(fingerprint(extended, [1000, 2000])).toEqual(fingerprint(full, [1000, 2000]))
  })

  test('only step-limit and aborted recordings can be extended', () => {
    expect(() => full.extend(10)).toThrow(InternalError)
    expect(() => recordSource('nil.x').extend(10)).toThrow(InternalError)
    expect(() => paused.extend(-5)).toThrow(InternalError)
  })
})
