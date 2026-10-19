import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import type { Recording, StateView } from './api-types'
import type { Program } from './bytecode'
import { buildStateView } from './inspector'
import { ProtoTable } from './inspector-location'
import { record } from './recorder'
import type { RuntimeDeps } from './runtime-types'
import { compileMain, freshVMAt, testRuntime } from './testing/recording'

const PROGRAMS: Record<string, string> = {
  siblings: 'fn sq(x) {\n  x * x\n}\nlet a = sq(2) + sq(3)\nprint(a)',
  recursion: 'fn fact(n) {\n  if n <= 1 { return 1 }\n  n * fact(n - 1)\n}\nprint(fact(6))',
  closures:
    'fn counter() {\n  var n = 0\n  let inc = || { n = n + 1\n    n }\n  inc()\n  inc\n}\nlet c = counter()\nc()\nprint(c())',
  lists:
    'var xs = [10, 20]\npush(xs, 30)\ninsert(xs, 0, 5)\nxs[1] = 11\nremove(xs, 0)\npop(xs)\nlet zs = [0, ...xs]\nprint(zs)',
  records: 'var r = {a: 1}\nr.a = 2\nr.b = [r]\ndelete(r, "a")\nfor k in r { print(k) }',
  matching:
    'fn m(v) {\n  match v {\n    [a, ...rest] if a > 1 => len(rest),\n    {x} => x,\n    n => n,\n  }\n}\nprint(m([2, 3, 4]))\nprint(m({x: 7}))\nprint(m(1))',
  error: 'var t = 0\nfor i in 0..5 {\n  t += i\n}\nlet q = [1][t]',
}

interface Subject {
  readonly program: Program
  readonly runtime: RuntimeDeps
  readonly recording: Recording
}

function subject(source: string, snapshotBudget?: number): Subject {
  const program = compileMain(source)
  const runtime = testRuntime()
  return { program, runtime, recording: record(program, runtime, { snapshotBudget }) }
}

/** The view the inspector builds on a fresh VM run to `t`, with the recording's metadata. */
function referenceView({ program, runtime, recording }: Subject, t: number): StateView {
  const vm = freshVMAt(program, runtime, t)
  const outcome = recording.outcome
  return buildStateView(
    vm,
    { table: new ProtoTable(program, runtime.libraryProtos), heapLimit: 250 },
    {
      time: t,
      location: recording.locationAt(t),
      outputCount: recording.outputCountAt(t),
      error: t === recording.length && outcome.kind === 'error' ? outcome.error : null,
    },
  )
}

function expectSameView(actual: StateView, expected: StateView): void {
  expect(actual).toEqual(expected)
  expect([...actual.heap.keys()]).toEqual([...expected.heap.keys()])
}

describe('stateAt equals a fresh run to t (ARCHITECTURE §10.3)', () => {
  for (const [name, source] of Object.entries(PROGRAMS)) {
    test(`${name}: every time`, () => {
      const run = subject(source)
      for (let t = 0; t <= run.recording.length; t++) {
        expectSameView(run.recording.stateAt(t), referenceView(run, t))
      }
    })
  }

  test('random-order seeks agree, with heavy snapshot thinning', () => {
    const source =
      'var acc = []\nfor i in 0..300 {\n  push(acc, {i: i, sq: i * i})\n  if len(acc) > 5 { remove(acc, 0) }\n}'
    const thinned = subject(source, 2)
    const plain = subject(source)
    const n = thinned.recording.length
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: n }), { minLength: 1, maxLength: 12 }),
        (times) => {
          for (const t of times) {
            expectSameView(thinned.recording.stateAt(t), referenceView(thinned, t))
            expect(plain.recording.stateAt(t)).toEqual(thinned.recording.stateAt(t))
          }
        },
      ),
      { numRuns: 30 },
    )
  })
})

const STATEMENTS = [
  'push(xs, i * 3)',
  'acc += i',
  'if i % 2 == 0 { insert(xs, 0, i) }',
  'if len(xs) > 2 { remove(xs, 1) }',
  'if len(xs) > 0 { xs[0] = {v: i} }',
  'if len(xs) > 3 { pop(xs) }',
  'let f = |y| y + i\n  acc = f(acc)',
  'rec[str(i % 3)] = acc',
  'acc = acc + xs[i % 4]',
]

const generatedProgram = fc
  .record({
    count: fc.integer({ min: 0, max: 12 }),
    body: fc.array(fc.constantFrom(...STATEMENTS), { minLength: 1, maxLength: 5 }),
  })
  .map(
    ({ count, body }) =>
      `var acc = 0\nvar xs = []\nvar rec = {}\nfor i in 0..${count} {\n  ${body.join('\n  ')}\n}\nprint(acc)`,
  )

describe('generated programs', () => {
  test('seeks, navigation and origin obey their invariants', () => {
    fc.assert(
      fc.property(
        generatedProgram,
        fc.array(fc.nat(), { minLength: 1, maxLength: 6 }),
        (source, picks) => {
          const run = subject(source, 3)
          const n = run.recording.length
          for (const pick of picks) {
            const t = pick % (n + 1)
            expectSameView(run.recording.stateAt(t), referenceView(run, t))
            for (const kind of ['into', 'over', 'out'] as const) {
              const forward = run.recording.step(t, kind, 'forward')
              const backward = run.recording.step(t, kind, 'backward')
              expect(forward > t || forward === n).toBe(true)
              expect(backward < t || backward === 0).toBe(true)
            }
            const origin = run.recording.origin({ kind: 'global', name: 'acc' }, t)
            if (origin !== null) expect(origin.time).toBeLessThan(t)
          }
        },
      ),
      { numRuns: 40 },
    )
  })
})
