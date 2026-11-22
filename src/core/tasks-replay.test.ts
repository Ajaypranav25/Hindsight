import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import type { Recording, ScheduleOptions } from './api-types'
import {
  decodeTraceFileSync,
  encodeTraceFileSync,
  openTraceBundle,
  openTraceFileSync,
  record,
  run,
  traceBundle,
  type TraceBundle,
} from './index'
import { replayAccess } from './recorder'
import { BANK_RACE, PIPELINE, compileTasks } from './testing/tasks'
import { validateBundle } from './trace-validate'

const RANDOM: ScheduleOptions = { policy: 'random', quantum: 4, seed: 11 }

function recordTasks(source: string, schedule?: ScheduleOptions, maxSteps?: number): Recording {
  return record(compileTasks(source), { schedule, maxSteps })
}

function texts(recording: Recording): string[] {
  return recording.outputs.map((event) => event.text)
}

function bundleOf(recording: Recording, base?: Recording): TraceBundle {
  const result = traceBundle({ recording, base, time: 0, hindsightVersion: '0.4.0' })
  if (!result.ok) throw new Error(result.error)
  return result.bundle
}

describe('recordings with tasks', () => {
  test('a recording under a schedule prints what a run under it prints', () => {
    // Arrange
    const program = compileTasks(BANK_RACE)

    // Act
    const recording = record(program, { schedule: RANDOM })
    const result = run(program, { schedule: RANDOM })

    // Assert
    expect(texts(recording)).toEqual(result.outputs.map((event) => event.text))
    expect(recording.length).toBe(result.steps)
    expect(recording.outcome).toEqual(result.outcome)
  })

  test('a round-robin schedule is stored as no schedule', () => {
    // Arrange, Act
    const recording = recordTasks(PIPELINE, { policy: 'round-robin', quantum: 3 })

    // Assert
    expect(replayAccess(recording)?.core.taskSchedule).toBeUndefined()
  })

  test('extending a step-limited recording continues under the same schedule', () => {
    // Arrange
    const whole = recordTasks(PIPELINE, RANDOM)
    const paused = recordTasks(PIPELINE, RANDOM, 150)

    // Act
    const extended = paused.extend(1_000_000)

    // Assert
    expect(paused.outcome.kind).toBe('step-limit')
    expect(extended.length).toBe(whole.length)
    expect(texts(extended)).toEqual(texts(whole))
    expect(extended.stateAt(200)).toEqual(whole.stateAt(200))
  })

  test('a what-if fork of a racy run replays the same schedule after the edit', () => {
    // Arrange: fork just after the first write of balance, setting it to 1000.
    const base = recordTasks(BANK_RACE, RANDOM)
    const write = base.history({ kind: 'global', name: 'balance' }, base.length).events[1]!

    // Act
    const forked = base.fork(write.time + 1, {
      target: { kind: 'global', name: 'balance' },
      value: 1000,
    })

    // Assert
    if (!forked.ok) throw new Error(forked.error.message)
    const final = Number(texts(forked.recording)[0])
    expect(final).toBe(Number(texts(base)[0]) + 1000 - Number(write.value))
  })

  test('a what-if edit can change a local of a task that is not running', () => {
    // Arrange: main blocks in wait while the worker's local n is live.
    const source = `
      fn worker(n) {
        yield()
        return n * 2
      }
      let t = spawn(worker, 5)
      print(wait(t))
    `
    const base = recordTasks(source)
    const declared = base
      .history({ kind: 'global', name: 't' }, base.length)
      .events.find((event) => event.kind === 'declare')!
    // At the first step where main runs after the spawn, the worker has frame uid 2.
    const time = declared.time + 1

    // Act
    const forked = base.fork(time, { target: { kind: 'local', frameUid: 2, slot: 1 }, value: 21 })

    // Assert
    if (!forked.ok) throw new Error(forked.error.message)
    expect(texts(base)).toEqual(['10'])
    expect(texts(forked.recording)).toEqual(['42'])
  })
})

describe('trace files with tasks', () => {
  test('a trace of a random schedule stores it and opens to the same run', () => {
    // Arrange
    const recording = recordTasks(BANK_RACE, RANDOM)
    const bundle = bundleOf(recording)

    const encoded = encodeTraceFileSync(bundle, (bytes) => gzipSync(bytes))
    if (!encoded.ok) throw new Error(encoded.error)
    const gunzip = (bytes: Uint8Array): Uint8Array => gunzipSync(bytes)

    // Act
    const decoded = decodeTraceFileSync(encoded.bytes, gunzip)
    const opened = openTraceFileSync(encoded.bytes, gunzip)

    // Assert
    expect(bundle.schedule).toEqual({ policy: 'random', quantum: 4, seed: 11 })
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.bundle.schedule).toEqual(bundle.schedule)
    if (!opened.ok) throw new Error(opened.error)
    expect(opened.verification).toEqual({ verified: true })
    expect(texts(opened.recording)).toEqual(texts(recording))
  })

  test('a round-robin trace has no schedule field, like files written before tasks', () => {
    // Arrange
    const bundle = bundleOf(recordTasks(PIPELINE))

    // Act
    const json = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>

    // Assert
    expect('schedule' in json).toBe(false)
    expect(openTraceBundle(bundle).ok).toBe(true)
  })

  test('opening a random-schedule trace without its schedule does not verify', () => {
    // Arrange
    const bundle = bundleOf(recordTasks(BANK_RACE, RANDOM))
    const { schedule: _dropped, ...withoutSchedule } = bundle

    // Act
    const replay = openTraceBundle(withoutSchedule)

    // Assert
    if (!replay.ok) throw new Error(replay.error)
    expect(replay.verification.verified).toBe(false)
  })

  test.each([
    [{ policy: 'round-robin' }, "schedule.policy must be 'random'"],
    [{ policy: 'random', quantum: 0, seed: 1 }, 'schedule.quantum'],
    [{ policy: 'random', quantum: 3, seed: -1 }, 'schedule.seed'],
    ['random', 'schedule must be'],
  ])('a schedule field %j is rejected', (schedule, message) => {
    // Arrange
    const bundle = { ...bundleOf(recordTasks(PIPELINE)), schedule }

    // Act
    const result = validateBundle(JSON.parse(JSON.stringify(bundle)))

    // Assert
    expect(result).toContain(message)
  })
})
