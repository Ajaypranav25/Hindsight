import { afterEach, describe, expect, test, vi } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { fakeRecording } from '../state/testing'
import { AnalysisClient, type WorkerLike } from './client'
import { AnalysisCancelled, type AnalysisBackend, localAnalysis } from './local'
import type { AnalysisRequest, AnalysisResult } from './protocol'
import { FakeWorker } from './testing'

const SHIPPING =
  'var total = 50\ntotal = total + 22\nif total > 80 {\n  print("free")\n}\nprint(total)\n'
const PRICE = ['let price = 30', 'let qty = 2', 'print(price * qty)', ''].join('\n')

function recordSource(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('fixture does not compile')
  return record(compiled.program)
}

/** A client over fake workers, with every worker it started and every main-thread job. */
function setup(options: { broken?: boolean; createWorker?: (() => WorkerLike) | null } = {}) {
  const workers: FakeWorker[] = []
  const local: AnalysisRequest[] = []
  const fallback: AnalysisBackend = {
    analyze(recording, request, signal) {
      local.push(request)
      return localAnalysis.analyze(recording, request, signal)
    },
  }
  const client = new AnalysisClient({
    createWorker:
      options.createWorker !== undefined
        ? options.createWorker
        : () => {
            const worker = new FakeWorker({ broken: options.broken })
            workers.push(worker)
            return worker
          },
    fallback,
  })
  return { client, workers, local }
}

const analyses = (worker: FakeWorker) =>
  worker.received.filter((message) => message.type === 'analyze').map((message) => message.id)

const slice = (at: number): AnalysisRequest => ({ kind: 'slice', at })
const solve: AnalysisRequest = { kind: 'solve', goal: { kind: 'output', index: 0, text: '100' } }

afterEach(() => {
  vi.useRealTimers()
})

describe('jobs go to the worker', () => {
  test('a slice comes back from the worker exactly as the main thread computes it', async () => {
    // Arrange
    const recording = recordSource(SHIPPING)
    const { client, workers, local } = setup()
    const at = recording.outputs[0]!.time
    // Act
    const result = await client.analyze(recording, slice(at))
    // Assert
    expect(result).toEqual(await localAnalysis.analyze(recording, slice(at)))
    expect(workers).toHaveLength(1)
    expect(local).toEqual([])
    expect(client.usesWorkers).toBe(true)
  })

  test('searches use a second worker, so a long search never holds up a slice', async () => {
    const recording = recordSource(PRICE)
    const { client, workers } = setup()
    const searching = client.analyze(recording, solve)
    const sliced = client.analyze(recording, slice(2))
    const [found, traced] = await Promise.all([searching, sliced])
    expect(found.kind).toBe('solve')
    expect(traced.kind).toBe('slice')
    expect(workers).toHaveLength(2)
    expect(workers.map(analyses)).toEqual([[1], [2]])
  })

  test('jobs of one lane are sent one at a time', async () => {
    const recording = recordSource(SHIPPING)
    const { client, workers } = setup()
    const first = client.analyze(recording, slice(1))
    const second = client.analyze(recording, { kind: 'query', text: 'changed(total)', limit: 9 })
    expect(analyses(workers[0]!)).toEqual([1])
    await first
    await second
    expect(analyses(workers[0]!)).toEqual([1, 2])
  })
})

describe('cancelling', () => {
  test('a queued job is dropped without reaching the worker', async () => {
    const recording = recordSource(SHIPPING)
    const { client, workers } = setup()
    const first = client.analyze(recording, slice(1))
    const controller = new AbortController()
    const second = client.analyze(recording, slice(2), controller.signal)
    controller.abort()
    await expect(second).rejects.toBeInstanceOf(AnalysisCancelled)
    await first
    expect(analyses(workers[0]!)).toEqual([1])
  })

  test('an aborted signal rejects at once', async () => {
    const { client } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.analyze(recordSource(SHIPPING), slice(0), controller.signal),
    ).rejects.toBeInstanceOf(AnalysisCancelled)
  })

  test('a search in flight is told to stop', async () => {
    const recording = recordSource(PRICE)
    const { client, workers } = setup()
    const controller = new AbortController()
    const searching = client.analyze(recording, solve, controller.signal)
    controller.abort()
    await expect(searching).rejects.toBeInstanceOf(AnalysisCancelled)
    await vi.waitFor(() =>
      expect(workers[0]!.received.map((message) => message.type)).toEqual(['analyze', 'cancel']),
    )
    // The lane moves on once the worker confirms.
    expect((await client.analyze(recording, solve)).kind).toBe('solve')
  })

  test('a pass nobody waits for is abandoned with its worker when other work arrives', async () => {
    const recording = recordSource(SHIPPING)
    const { client, workers } = setup()
    const controller = new AbortController()
    const first = client.analyze(recording, slice(1), controller.signal)
    controller.abort()
    await expect(first).rejects.toBeInstanceOf(AnalysisCancelled)
    const second = await client.analyze(recording, slice(2))
    expect(second.kind).toBe('slice')
    expect(workers).toHaveLength(2)
    expect(workers[0]!.terminated).toBe(true)
    expect(analyses(workers[1]!)).toEqual([2])
  })

  test('the same job asked for again right after it was cancelled carries on', async () => {
    const recording = recordSource(SHIPPING)
    const { client, workers } = setup()
    const controller = new AbortController()
    const first = client.analyze(recording, slice(4), controller.signal)
    controller.abort()
    const again = client.analyze(recording, slice(4))
    await expect(first).rejects.toBeInstanceOf(AnalysisCancelled)
    expect((await again).kind).toBe('slice')
    expect(workers).toHaveLength(1)
    expect(analyses(workers[0]!)).toEqual([1])
  })

  test('dispose stops the workers and rejects what is pending', async () => {
    const recording = recordSource(SHIPPING)
    const { client, workers } = setup()
    const pending = client.analyze(recording, slice(1))
    client.dispose()
    await expect(pending).rejects.toBeInstanceOf(AnalysisCancelled)
    expect(workers[0]!.terminated).toBe(true)
  })
})

describe('the main thread does the work when the worker cannot', () => {
  test('without workers', async () => {
    const { client, local } = setup({ createWorker: null })
    const result = await client.analyze(recordSource(SHIPPING), slice(2))
    expect(result.kind).toBe('slice')
    expect(local).toEqual([slice(2)])
    expect(client.usesWorkers).toBe(false)
  })

  test('when starting a worker throws', async () => {
    const { client, local } = setup({
      createWorker: () => {
        throw new Error('workers are blocked here')
      },
    })
    await client.analyze(recordSource(SHIPPING), slice(2))
    expect(local).toEqual([slice(2)])
    expect(client.usesWorkers).toBe(false)
  })

  test('when the worker fails before it is ready, and for every job after', async () => {
    const recording = recordSource(SHIPPING)
    const { client, local, workers } = setup({ broken: true })
    const first = client.analyze(recording, slice(1))
    const second = client.analyze(recording, slice(2))
    expect((await first).kind).toBe('slice')
    expect((await second).kind).toBe('slice')
    expect(local).toEqual([slice(1), slice(2)])
    expect(workers).toHaveLength(1)
    expect(client.usesWorkers).toBe(false)
  })

  test('when the worker crashes later, the job is redone and the next worker is fresh', async () => {
    const recording = recordSource(PRICE)
    const { client, local, workers } = setup()
    await client.analyze(recording, solve)
    const searching = client.analyze(recording, solve)
    expect(analyses(workers[0]!)).toEqual([1, 2])
    workers[0]!.crash()
    expect((await searching).kind).toBe('solve')
    expect(local).toEqual([solve])
    await client.analyze(recording, solve)
    expect(workers.map((worker) => worker.terminated)).toEqual([true, false])
    expect(client.usesWorkers).toBe(true)
  })

  test('when the run cannot be described or recorded again', async () => {
    const recording = recordSource(SHIPPING)
    const stopped = fakeRecording({ length: 3, outcome: { kind: 'aborted' } })
    const { client, local } = setup()
    const fallback = vi.spyOn(localAnalysis, 'analyze').mockResolvedValue({
      kind: 'slice',
      slice: null,
    } satisfies AnalysisResult)
    await client.analyze(stopped, slice(1))
    expect(local).toEqual([slice(1)])
    // A recording whose program text does not compile (a doctored one) fails in the worker.
    const odd = { ...recording, program: { ...recording.program, source: 'let = 1' } }
    const result = await client.analyze(odd as Recording, slice(1))
    fallback.mockRestore()
    expect(result.kind).toBe('slice')
    expect(local).toEqual([slice(1), slice(1)])
  })
})
