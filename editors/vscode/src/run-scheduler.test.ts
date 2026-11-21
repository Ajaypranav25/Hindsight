import { describe, expect, test } from 'vitest'
import { type AbortFlag, RunScheduler, type Timers } from './run-scheduler'

/** Timers that fire only when the test says so. */
class ManualTimers implements Timers {
  private next = 1
  readonly pending = new Map<number, { callback: () => void; ms: number }>()

  set(callback: () => void, ms: number): unknown {
    const handle = this.next++
    this.pending.set(handle, { callback, ms })
    return handle
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number)
  }

  fireAll(): void {
    const due = [...this.pending.values()]
    this.pending.clear()
    for (const timer of due) timer.callback()
  }
}

/** A job that finishes when the test resolves it, and remembers its abort flag. */
function controllable<R>() {
  const runs: { signal: AbortFlag; resolve: (value: R) => void }[] = []
  const job = (signal: AbortFlag) =>
    new Promise<R>((resolve) => {
      runs.push({ signal, resolve })
    })
  return { job, runs }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('run scheduler', () => {
  test('runs a scheduled job once after the delay, however many saves came before', async () => {
    // Arrange
    const timers = new ManualTimers()
    const scheduler = new RunScheduler(timers)
    const results: string[] = []
    let calls = 0
    const job = async () => `run ${++calls}`

    // Act
    scheduler.schedule('a', 300, job, (r) => results.push(r))
    scheduler.schedule('a', 300, job, (r) => results.push(r))
    scheduler.schedule('a', 300, job, (r) => results.push(r))
    expect(timers.pending.size).toBe(1)
    expect(scheduler.busy('a')).toBe(true)
    timers.fireAll()
    await flush()

    // Assert
    expect(results).toEqual(['run 1'])
    expect(scheduler.busy('a')).toBe(false)
  })

  test('a new run aborts the one in flight, whose result is dropped', async () => {
    const scheduler = new RunScheduler(new ManualTimers())
    const { job, runs } = controllable<string>()

    const first = scheduler.run('a', job)
    const second = scheduler.run('a', job)
    expect(runs[0]!.signal.aborted).toBe(true)
    expect(runs[1]!.signal.aborted).toBe(false)
    runs[0]!.resolve('old')
    runs[1]!.resolve('new')

    expect(await first).toBeNull()
    expect(await second).toEqual({ value: 'new' })
    expect(scheduler.busy('a')).toBe(false)
  })

  test('running now cancels a pending scheduled run', async () => {
    const timers = new ManualTimers()
    const scheduler = new RunScheduler(timers)
    const done: string[] = []

    scheduler.schedule(
      'a',
      300,
      async () => 'scheduled',
      (r) => done.push(r),
    )
    const now = await scheduler.run('a', async () => 'now')
    timers.fireAll()
    await flush()

    expect(now).toEqual({ value: 'now' })
    expect(done).toEqual([])
  })

  test('a scheduled run superseded while recording reports nothing', async () => {
    const timers = new ManualTimers()
    const scheduler = new RunScheduler(timers)
    const { job, runs } = controllable<string>()
    const done: string[] = []

    scheduler.schedule('a', 300, job, (r) => done.push(r))
    timers.fireAll()
    const newer = scheduler.run('a', async () => 'newer')
    runs[0]!.resolve('stale')
    await flush()

    expect(await newer).toEqual({ value: 'newer' })
    expect(done).toEqual([])
  })

  test('keeps documents apart', async () => {
    const scheduler = new RunScheduler(new ManualTimers())
    const { job, runs } = controllable<string>()

    const a = scheduler.run('a', job)
    const b = scheduler.run('b', job)
    runs[0]!.resolve('A')
    runs[1]!.resolve('B')

    expect(runs.map((r) => r.signal.aborted)).toEqual([false, false])
    expect([await a, await b]).toEqual([{ value: 'A' }, { value: 'B' }])
  })

  test('cancel stops the pending and the running job of a closed document', async () => {
    const timers = new ManualTimers()
    const scheduler = new RunScheduler(timers)
    const { job, runs } = controllable<string>()

    const running = scheduler.run('a', job)
    scheduler.schedule('a', 300, job, () => undefined)
    scheduler.cancel('a')
    scheduler.cancel('never-seen')
    runs[0]!.resolve('late')

    expect(runs[0]!.signal.aborted).toBe(true)
    expect(timers.pending.size).toBe(0)
    expect(await running).toBeNull()
    expect(scheduler.busy('a')).toBe(false)
  })

  test('dispose stops every document', () => {
    const timers = new ManualTimers()
    const scheduler = new RunScheduler(timers)

    scheduler.schedule(
      'a',
      300,
      async () => 1,
      () => undefined,
    )
    scheduler.schedule(
      'b',
      300,
      async () => 2,
      () => undefined,
    )
    scheduler.dispose()

    expect(timers.pending.size).toBe(0)
    expect(scheduler.busy('a') || scheduler.busy('b')).toBe(false)
  })

  test('a failing job clears the run and rejects to its caller', async () => {
    const scheduler = new RunScheduler(new ManualTimers())

    await expect(
      scheduler.run('a', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(scheduler.busy('a')).toBe(false)
  })
})

describe('run scheduler failures', () => {
  test('a scheduled job that throws reaches the failure callback, not the result one', async () => {
    const timers = new ManualTimers()
    const scheduler = new RunScheduler(timers)
    const done: unknown[] = []
    const failed: unknown[] = []

    scheduler.schedule(
      'a',
      300,
      async () => {
        throw new Error('internal')
      },
      (r) => done.push(r),
      (e) => failed.push(e),
    )
    timers.fireAll()
    await flush()

    expect(done).toEqual([])
    expect(failed).toEqual([new Error('internal')])
  })

  test('without a failure callback a throwing scheduled job is swallowed quietly', async () => {
    const timers = new ManualTimers()
    const scheduler = new RunScheduler(timers)

    scheduler.schedule(
      'a',
      300,
      async () => {
        throw new Error('ignored')
      },
      () => undefined,
    )
    timers.fireAll()
    await flush()

    expect(scheduler.busy('a')).toBe(false)
  })
})
