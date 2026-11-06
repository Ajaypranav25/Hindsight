import { describe, expect, test } from 'vitest'
import type {
  ForkEdit,
  ForkErrorCode,
  ForkResult,
  Recording,
  StateView,
  ValueView,
  WriteTarget,
} from './api-types'
import { recordSource } from './testing/recording'

const TOTALS = [
  'var total = 0',
  'for i in 1..=5 {',
  '  total += i',
  '  print(total)',
  '}',
  'print("done")',
].join('\n')

const TOTAL: WriteTarget = { kind: 'global', name: 'total' }

function forked(result: ForkResult): Recording {
  if (!result.ok) throw new Error(`fork failed: ${result.error.message}`)
  return result.recording
}

function errorCode(result: ForkResult): ForkErrorCode | null {
  return result.ok ? null : result.error.code
}

function texts(recording: Recording): string[] {
  return recording.outputs.map((event) => event.text)
}

/** The step at which the `nth` (0-based) run of the statement on `line` starts. */
function hit(recording: Recording, line: number, nth: number): number {
  const time = recording.lineHits(line)[nth]
  if (time === undefined) throw new Error(`line ${line} has no hit ${nth}`)
  return time
}

function globalValue(view: StateView, name: string): ValueView | undefined {
  return view.globals.find((global) => global.name === name)?.value
}

function refId(value: ValueView | undefined): number {
  if (value?.kind !== 'ref') throw new Error(`not an object: ${JSON.stringify(value)}`)
  return value.id
}

describe('fork', () => {
  test('an edit changes the future and keeps the past', () => {
    // Arrange
    const parent = recordSource(TOTALS)
    const time = hit(parent, 3, 2)
    const edit: ForkEdit = { target: TOTAL, value: 100 }

    // Act
    const fork = forked(parent.fork(time, edit))

    // Assert
    expect(texts(parent)).toEqual(['1', '3', '6', '10', '15', 'done'])
    expect(texts(fork)).toEqual(['1', '3', '103', '107', '112', 'done'])
    expect(fork.outcome).toEqual({ kind: 'finished' })
    expect(fork.whatIf).toEqual({
      parentLength: parent.length,
      time,
      edit,
      edits: [{ time, edit }],
    })
    expect(parent.whatIf).toBeNull()
  })

  test('states before the fork step are the parent’s; the edit shows at the fork step', () => {
    const parent = recordSource(TOTALS)
    const time = hit(parent, 3, 2)
    const fork = forked(parent.fork(time, { target: TOTAL, value: 100 }))
    for (let t = 0; t < time; t++) {
      expect(fork.stateAt(t)).toEqual(parent.stateAt(t))
      expect(fork.locationAt(t)).toEqual(parent.locationAt(t))
    }
    expect(globalValue(parent.stateAt(time), 'total')).toEqual({ kind: 'number', value: 3 })
    expect(globalValue(fork.stateAt(time), 'total')).toEqual({ kind: 'number', value: 100 })
    expect(fork.outputCountAt(time)).toBe(parent.outputCountAt(time))
  })

  test('the edit is recorded as a write event at the fork step', () => {
    const parent = recordSource(TOTALS)
    const time = hit(parent, 3, 2)
    const fork = forked(parent.fork(time, { target: TOTAL, value: 100 }))
    expect(fork.origin(TOTAL, time + 1)).toMatchObject({
      time,
      kind: 'write',
      target: TOTAL,
      value: 100,
    })
    const writes = fork.history(TOTAL, fork.length).events.map((event) => event.value)
    expect(writes).toEqual([0, 1, 3, 100, 103, 107, 112])
  })

  test('a local, named by frame uid and slot', () => {
    const source = [
      'fn sum(n) {',
      '  var acc = 0',
      '  for i in 1..=n {',
      '    acc += i',
      '  }',
      '  acc',
      '}',
      'print(sum(4))',
      'print(sum(3))',
    ].join('\n')
    const parent = recordSource(source)
    const time = hit(parent, 4, 1)
    const acc = parent
      .stateAt(time)
      .frames.at(-1)!
      .locals.find((local) => local.name === 'acc')!
    const fork = forked(parent.fork(time, { target: acc.target, value: 50 }))
    expect(texts(parent)).toEqual(['10', '6'])
    expect(texts(fork)).toEqual(['59', '6'])
  })

  test('list elements and record fields', () => {
    const parent = recordSource('let xs = [1, 2, 3]\nlet r = {a: 1}\nprint(xs[1])\nprint(r.a)')
    const time = hit(parent, 3, 0)
    const view = parent.stateAt(time)
    const xs = refId(globalValue(view, 'xs'))
    const r = refId(globalValue(view, 'r'))
    const element = { kind: 'element', objectId: xs, index: 1 } as const
    const field = { kind: 'field', objectId: r, key: 'a' } as const
    expect(texts(forked(parent.fork(time, { target: element, value: 'two' })))).toEqual([
      'two',
      '1',
    ])
    expect(texts(forked(parent.fork(time, { target: field, value: true })))).toEqual(['2', 'true'])
    expect(texts(forked(parent.fork(time, { target: field, value: null })))).toEqual(['2', 'nil'])
  })

  test('captured variables: a closed cell, and an open one through its owner’s local', () => {
    const closed = recordSource(
      [
        'fn counter() {',
        '  var n = 0',
        '  let inc = || {',
        '    n = n + 1',
        '    n',
        '  }',
        '  inc',
        '}',
        'let c = counter()',
        'c()',
        'print(c())',
      ].join('\n'),
    )
    const time = hit(closed, 11, 0)
    const fn = closed.objectAt(time, refId(globalValue(closed.stateAt(time), 'c')))
    if (fn?.type !== 'function') throw new Error('c is not a function')
    expect(fn.captures[0]!.target.kind).toBe('cell')
    const fork = forked(closed.fork(time, { target: fn.captures[0]!.target, value: 10 }))
    expect(texts(closed)).toEqual(['2'])
    expect(texts(fork)).toEqual(['11'])

    const open = recordSource(
      'fn outer() {\n  var n = 1\n  let get = || n\n  print(get())\n}\nouter()',
    )
    const at = hit(open, 4, 0)
    const n = open
      .stateAt(at)
      .frames.at(-1)!
      .locals.find((local) => local.name === 'n')!
    expect(texts(forked(open.fork(at, { target: n.target, value: 'edited' })))).toEqual(['edited'])
  })

  test('invalid requests return typed errors', () => {
    const parent = recordSource('let xs = [1]\nlet r = {a: 1}\nvar total = 0\nprint(xs)')
    const edit: ForkEdit = { target: TOTAL, value: 1 }
    const late = parent.length - 1
    const view = parent.stateAt(late)
    const xs = refId(globalValue(view, 'xs'))
    const r = refId(globalValue(view, 'r'))
    const top = view.frames[0]!.uid
    const at = (target: WriteTarget) => errorCode(parent.fork(late, { target, value: 1 }))
    expect(errorCode(parent.fork(-1, edit))).toBe('time')
    expect(errorCode(parent.fork(parent.length, edit))).toBe('time')
    expect(errorCode(parent.fork(1.5, edit))).toBe('time')
    expect(errorCode(parent.fork(0, edit))).toBe('target')
    expect(at({ kind: 'global', name: 'nope' })).toBe('target')
    expect(at({ kind: 'object', objectId: xs })).toBe('target')
    expect(at({ kind: 'local', frameUid: 999, slot: 1 })).toBe('target')
    expect(at({ kind: 'local', frameUid: top, slot: 0 })).toBe('target')
    expect(at({ kind: 'element', objectId: xs, index: 1 })).toBe('target')
    expect(at({ kind: 'element', objectId: r, index: 0 })).toBe('target')
    expect(at({ kind: 'field', objectId: r, key: 'b' })).toBe('target')
    expect(at({ kind: 'field', objectId: 999, key: 'a' })).toBe('target')
    expect(at({ kind: 'cell', cellId: 999 })).toBe('target')
    const list = [1] as unknown as number
    expect(errorCode(parent.fork(late, { target: TOTAL, value: list }))).toBe('value')
    expect(errorCode(parent.fork(late, edit, { maxSteps: late }))).toBe('max-steps')
    expect(parent.fork(late, edit).ok).toBe(true)
  })

  test('a failure at the fork step itself ends the fork there', () => {
    const parent = recordSource('let xs = [3, 1, 2]\nprint(max(xs))')
    let time = hit(parent, 2, 0)
    while (parent.locationAt(time)?.opName !== 'Call') time++
    const xs = refId(globalValue(parent.stateAt(time), 'xs'))
    const target: WriteTarget = { kind: 'element', objectId: xs, index: 1 }
    const fork = forked(parent.fork(time, { target, value: 'one' }))
    expect(texts(parent)).toEqual(['3'])
    expect(fork.outcome.kind).toBe('error')
    expect(fork.length).toBe(time)
    const list = fork.objectAt(time, xs)
    expect(list?.type === 'list' && list.items[1]).toEqual({ kind: 'string', value: 'one' })
  })
})

describe('the fork step is a seek barrier', () => {
  const source = 'var total = 0\nfor i in 1..=3000 {\n  total += i\n}\nprint(total)'
  // A tiny snapshot budget makes the fork thin its snapshots while it records.
  const parent = recordSource(source, { snapshotBudget: 4 })
  const time = hit(parent, 3, 1500)
  const edit: ForkEdit = { target: TOTAL, value: -1_000_000 }
  const fresh = (t: number) => forked(parent.fork(time, edit)).stateAt(t)
  const late = [time, time + 1, time + 37, time + 5000, parent.length]

  test('seeking before, then after the fork step', () => {
    const fork = forked(parent.fork(time, edit))
    for (const t of late) {
      fork.stateAt(time - 1)
      expect(fork.stateAt(t)).toEqual(fresh(t))
      expect(fork.stateAt(t)).not.toEqual(parent.stateAt(t))
    }
  })

  test('seeking after, then before, then after again', () => {
    const fork = forked(parent.fork(time, edit))
    for (const t of late.toReversed()) {
      expect(fork.stateAt(t)).toEqual(fresh(t))
      expect(fork.stateAt(time - 3)).toEqual(parent.stateAt(time - 3))
      expect(fork.stateAt(t + (t < fork.length ? 1 : 0))).toEqual(
        fresh(t + (t < fork.length ? 1 : 0)),
      )
    }
    expect(texts(fork)).toEqual([String(4501500 - 1_000_000 - (1500 * 1501) / 2)])
  })
})

describe('forks of forks', () => {
  test('a later fork keeps the earlier edit', () => {
    const parent = recordSource(TOTALS)
    const first = forked(parent.fork(hit(parent, 3, 2), { target: TOTAL, value: 100 }))
    const second = forked(first.fork(hit(first, 3, 4), { target: TOTAL, value: 0 }))
    expect(texts(second)).toEqual(['1', '3', '103', '107', '5', 'done'])
    expect(second.whatIf?.edits.map((edit) => edit.time)).toEqual([
      hit(parent, 3, 2),
      hit(parent, 3, 4),
    ])
    expect(second.whatIf?.parentLength).toBe(first.length)
  })

  test('an earlier fork replaces the future that held the first edit', () => {
    const parent = recordSource(TOTALS)
    const first = forked(parent.fork(hit(parent, 3, 2), { target: TOTAL, value: 100 }))
    const second = forked(first.fork(hit(first, 3, 1), { target: TOTAL, value: 50 }))
    expect(texts(second)).toEqual(['1', '52', '55', '59', '64', 'done'])
    expect(second.whatIf?.edits).toHaveLength(1)
  })

  test('two edits at one step both apply and both stay in the history', () => {
    const parent = recordSource('var a = 0\nvar b = 0\nprint(a + b)')
    const time = hit(parent, 3, 0)
    const a: WriteTarget = { kind: 'global', name: 'a' }
    const b: WriteTarget = { kind: 'global', name: 'b' }
    const first = forked(parent.fork(time, { target: a, value: 1 }))
    const second = forked(first.fork(time, { target: b, value: 2 }))
    expect(texts(second)).toEqual(['3'])
    expect(second.whatIf?.edits).toHaveLength(2)
    expect(second.origin(a, time + 1)).toMatchObject({ time, kind: 'write', value: 1 })
    expect(second.origin(b, time + 1)).toMatchObject({ time, kind: 'write', value: 2 })
  })
})

describe('step limits', () => {
  const source = 'var total = 0\nfor i in 1..=200 {\n  total += i\n}\nprint(total)'
  const edit: ForkEdit = { target: TOTAL, value: 1000 }

  test('extend continues a step-limited fork like a fork with a larger limit', () => {
    const parent = recordSource(source, { maxSteps: 300 })
    const time = hit(parent, 3, 5)
    const fork = forked(parent.fork(time, edit))
    expect(fork.outcome).toEqual({ kind: 'step-limit', maxSteps: 300 })
    expect(fork.length).toBe(300)
    const extended = fork.extend(100_000)
    const direct = forked(parent.fork(time, edit, { maxSteps: 100_300 }))
    expect(extended.outcome).toEqual({ kind: 'finished' })
    expect(extended.length).toBe(direct.length)
    expect(texts(extended)).toEqual(['21085'])
    expect(texts(direct)).toEqual(['21085'])
    expect(extended.whatIf).toEqual(fork.whatIf)
    expect(fork.length).toBe(300)
  })

  test('forkAsync records in slices, reports progress and can be stopped', async () => {
    const parent = recordSource(source)
    const time = hit(parent, 3, 5)
    const progress: number[] = []
    const fork = forked(await parent.forkAsync(time, edit, { onProgress: (t) => progress.push(t) }))
    expect(texts(fork)).toEqual(['21085'])
    expect(progress.at(-1)).toBe(fork.length)
    const stopped = forked(await parent.forkAsync(time, edit, { signal: { aborted: true } }))
    expect(stopped.outcome).toEqual({ kind: 'aborted' })
    expect(stopped.length).toBe(time)
    expect(errorCode(await parent.forkAsync(parent.length, edit))).toBe('time')
    const extended = await stopped.extendAsync(100_000)
    expect(texts(extended)).toEqual(['21085'])
    expect(extended.whatIf).toEqual(fork.whatIf)
  })
})
