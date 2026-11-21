import { describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { createAnalysisHandler } from './handler'
import type { AnalysisRequest, FromWorker, RunDescription, ToWorker } from './protocol'
import { describeRun, recreateRun } from './run-description'

const SHIPPING =
  'var total = 50\ntotal = total + 22\nif total > 80 {\n  print("free")\n}\nprint(total)\n'

const PRICE = ['let price = 30', 'let qty = 2', 'print(price * qty)', ''].join('\n')

function recordSource(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('fixture does not compile')
  return record(compiled.program)
}

/** A handler whose pauses wait until `flush` runs them, with every post collected. */
function harness(options: { recreate?: typeof recreateRun } = {}) {
  const posts: { message: FromWorker; transfer: Transferable[] }[] = []
  const pending: (() => void)[] = []
  let clock = 0
  const recreated: RunDescription[] = []
  const handle = createAnalysisHandler({
    post: (message, transfer) => posts.push({ message, transfer }),
    schedule: (callback) => pending.push(callback),
    // Every look at the clock is a whole slice later, so a search pauses after each fork.
    now: () => (clock += 1000),
    recreate: (run) => {
      recreated.push(run)
      return (options.recreate ?? recreateRun)(run)
    },
  })
  const flush = () => {
    while (pending.length > 0) pending.shift()!()
  }
  return { handle, posts, pending, flush, recreated }
}

const analyze = (id: number, run: RunDescription, request: AnalysisRequest): ToWorker => ({
  type: 'analyze',
  id,
  run,
  request,
})

describe('the worker side of the protocol', () => {
  test('a slice is answered at once, its marks transferred', () => {
    // Arrange
    const recording = recordSource(SHIPPING)
    const run = describeRun(recording)!
    const { handle, posts } = harness()
    // Act
    handle(analyze(1, run, { kind: 'slice', at: recording.outputs[0]!.time }))
    // Assert
    expect(posts).toHaveLength(1)
    const { message, transfer } = posts[0]!
    expect(message.type).toBe('done')
    if (message.type === 'done' && message.result.kind === 'slice') {
      expect(message.result.slice!.lines).toEqual([1, 2, 6])
      expect(transfer).toEqual([message.result.slice!.marks.buffer])
    }
  })

  test('the run is recorded once for several analyses of it', () => {
    const recording = recordSource(SHIPPING)
    const run = describeRun(recording)!
    const { handle, posts, recreated } = harness()
    handle(analyze(1, run, { kind: 'query', text: 'changed(total)', limit: 5 }))
    handle(analyze(2, { ...run }, { kind: 'slice', at: 3 }))
    expect(posts.map((post) => post.message.type)).toEqual(['done', 'done'])
    expect(recreated).toHaveLength(1)
  })

  test('a run that cannot be recorded again fails the job, and the next one still runs', () => {
    const run = describeRun(recordSource(SHIPPING))!
    const { handle, posts } = harness()
    handle(analyze(1, { ...run, source: 'let = 2' }, { kind: 'slice', at: 0 }))
    handle(analyze(2, run, { kind: 'slice', at: 0 }))
    expect(posts.map((post) => post.message)).toEqual([
      { type: 'failed', id: 1, error: 'The program does not compile.' },
      expect.objectContaining({ type: 'done', id: 2 }),
    ])
  })

  test('an exception inside a job fails it', () => {
    const run = describeRun(recordSource(SHIPPING))!
    const broken = {
      get length(): number {
        throw new Error('no length today')
      },
    } as unknown as Recording
    const { handle, posts } = harness({ recreate: () => ({ ok: true, recording: broken }) })
    handle(analyze(7, run, { kind: 'slice', at: 0 }))
    expect(posts[0]!.message).toEqual({ type: 'failed', id: 7, error: 'no length today' })
  })

  test('a search works in slices and stops when cancelled; queued jobs wait their turn', () => {
    // Arrange
    const recording = recordSource(SHIPPING)
    const run = describeRun(recording)!
    const { handle, posts, pending, flush } = harness()
    const goal = { kind: 'output', index: 0, text: '100' } as const
    // Act
    handle(analyze(1, run, { kind: 'solve', goal }))
    handle(analyze(2, run, { kind: 'slice', at: 2 }))
    handle(analyze(3, run, { kind: 'slice', at: 3 }))
    handle({ type: 'cancel', id: 3 })
    // Assert: the search paused after its first fork; the queued slice was dropped.
    expect(pending).toHaveLength(1)
    expect(posts.map((post) => post.message)).toEqual([{ type: 'cancelled', id: 3 }])
    handle({ type: 'cancel', id: 1 })
    flush()
    expect(posts.map((post) => post.message.type)).toEqual(['cancelled', 'cancelled', 'done'])
    expect(posts[1]!.message).toEqual({ type: 'cancelled', id: 1 })
  })

  test('a sweep says how many values it has forked after every pause', () => {
    const recording = recordSource(PRICE)
    const run = describeRun(recording)!
    const { handle, posts, flush } = harness()
    const target = { kind: 'global', name: 'qty' } as const
    handle(analyze(4, run, { kind: 'sweep', time: 2, target, values: [1, 2, 3] }))
    flush()
    expect(posts.map((post) => post.message.type)).toEqual([
      'progress',
      'progress',
      'progress',
      'done',
    ])
    expect(posts.slice(0, 3).map((post) => post.message)).toEqual([
      { type: 'progress', id: 4, done: 1 },
      { type: 'progress', id: 4, done: 2 },
      { type: 'progress', id: 4, done: 3 },
    ])
  })

  test('an uncancelled search runs to its end; cancels of finished jobs are ignored', () => {
    const recording = recordSource(PRICE)
    const run = describeRun(recording)!
    const { handle, posts, flush } = harness()
    handle(analyze(1, run, { kind: 'solve', goal: { kind: 'output', index: 0, text: '100' } }))
    flush()
    handle({ type: 'cancel', id: 1 })
    expect(posts).toHaveLength(1)
    const message = posts[0]!.message
    expect(message.type).toBe('done')
    if (message.type === 'done' && message.result.kind === 'solve') {
      expect(message.result.result.solutions.length).toBeGreaterThan(0)
    }
  })
})
