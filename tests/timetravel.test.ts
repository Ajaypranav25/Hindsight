/**
 * Time-travel properties (ARCHITECTURE §10.3) over the passing corpus programs and generated
 * programs, through the public API with the real library.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  type Program,
  type Recording,
  type StateView,
  type StepKind,
  type WriteTarget,
  compile,
  record,
  run,
} from '../src/core/index'
import { buildStateView } from '../src/core/inspector'
import { ProtoTable } from '../src/core/inspector-location'
import { getLibrary } from '../src/core/library'
import type { VM } from '../src/core/runtime-types'
import { digest } from '../src/core/testing/vm-digest'
import { createVM } from '../src/core/vm'

/** Corpus programs longer than this are skipped to keep the suite fast. */
const CORPUS_STEP_LIMIT = 20_000
const HEAP_LIMIT = 250
const CORPUS_DIR = fileURLToPath(new URL('./lang', import.meta.url))

interface Subject {
  readonly name: string
  readonly program: Program
  readonly recording: Recording
}

function freshVM(program: Program): VM {
  const library = getLibrary()
  return createVM(program, { builtins: library.builtins, libraryProtos: library.protos })
}

/** The view the inspector builds on a fresh VM run to `t`, with the recording's metadata. */
function referenceView({ program, recording }: Subject, t: number): StateView {
  const vm = freshVM(program)
  vm.runUntil(t)
  const outcome = recording.outcome
  return buildStateView(
    vm,
    { table: new ProtoTable(program, getLibrary().protos), heapLimit: HEAP_LIMIT },
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

function corpusSubjects(): Subject[] {
  const files = readdirSync(CORPUS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.sight'))
    .map((path) => path.split(sep).join('/'))
    .sort()
  const subjects: Subject[] = []
  for (const file of files) {
    const compiled = compile(readFileSync(join(CORPUS_DIR, file), 'utf8'))
    if (!compiled.ok) continue
    const fast = run(compiled.program, { maxSteps: CORPUS_STEP_LIMIT })
    if (fast.outcome.kind === 'step-limit') continue
    const recording = record(compiled.program, { maxSteps: CORPUS_STEP_LIMIT })
    subjects.push({ name: file, program: compiled.program, recording })
  }
  return subjects
}

function subjectOf(source: string, snapshotBudget?: number): Subject {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.diagnostics)}`)
  const recording = record(compiled.program, { snapshotBudget })
  return { name: 'generated', program: compiled.program, recording }
}

// ---------------------------------------------------------------------------------------------
// A brute-force navigator (ARCHITECTURE §7.2, without just-my-code) to compare against.

function isStmtStart(recording: Recording, t: number): boolean {
  return recording.locationAt(t)?.stmtStart ?? false
}

function depthAtEnd(recording: Recording): number {
  return recording.locationAt(recording.length)?.depth ?? 0
}

function depthOf(recording: Recording, depths: Int32Array, t: number): number {
  return t < recording.length ? depths[t]! : depthAtEnd(recording)
}

function expectedStep(recording: Recording, t: number, kind: StepKind, forward: boolean): number {
  const n = recording.length
  const depths = recording.depthSeries()
  const d = depthOf(recording, depths, t)
  let low = d
  const delta = forward ? 1 : -1
  for (let u = t + delta; forward ? u < n : u >= 0; u += delta) {
    low = Math.min(low, depths[u]!)
    if (kind === 'out' && depths[u]! < d) return u
    if (kind === 'into' && isStmtStart(recording, u)) return u
    if (kind === 'over' && isStmtStart(recording, u) && depths[u]! <= d && low >= depths[u]!) {
      return u
    }
  }
  return forward ? n : 0
}

/** Every write target visible in a state view: locals, captures, globals and heap objects. */
function visibleTargets(view: StateView): WriteTarget[] {
  const targets: WriteTarget[] = view.globals.map((g) => g.target)
  for (const frame of view.frames) {
    targets.push(...frame.locals.map((l) => l.target), ...frame.captures.map((c) => c.target))
  }
  for (const object of view.heap.values()) {
    targets.push({ kind: 'object', objectId: object.id })
    if (object.type === 'list' && object.length > 0) {
      targets.push({ kind: 'element', objectId: object.id, index: object.length - 1 })
    }
    if (object.type === 'record' && object.entries.length > 0) {
      targets.push({ kind: 'field', objectId: object.id, key: object.entries[0]!.key })
    }
  }
  return targets
}

const KINDS: readonly StepKind[] = ['into', 'over', 'out']

/** Checks every §10.3 property of one recording at time `t`. */
function checkMoment(subject: Subject, t: number): void {
  const { recording } = subject
  const n = recording.length
  expectSameView(recording.stateAt(t), referenceView(subject, t))
  for (const kind of KINDS) {
    for (const justMyCode of [false, true]) {
      const forward = recording.step(t, kind, 'forward', { justMyCode })
      const backward = recording.step(t, kind, 'backward', { justMyCode })
      expect(forward > t || forward === n).toBe(true)
      expect(backward < t || backward === 0).toBe(true)
    }
    expect(recording.step(t, kind, 'forward')).toBe(expectedStep(recording, t, kind, true))
    expect(recording.step(t, kind, 'backward')).toBe(expectedStep(recording, t, kind, false))
  }
  const lines = new Set([recording.locationAt(t)?.stmtLine ?? 1, 1, 2, 3])
  const next = recording.continue(t, 'forward', lines)
  const previous = recording.continue(t, 'backward', lines)
  expect(next > t || next === n).toBe(true)
  expect(previous < t || previous === 0).toBe(true)
  for (const target of visibleTargets(recording.stateAt(t))) {
    const origin = recording.origin(target, t)
    if (origin !== null) expect(origin.time).toBeLessThan(t)
    const events = recording.history(target, t).events
    events.forEach((event, i) => {
      expect(event.time).toBeLessThan(n)
      if (i > 0) expect(event.time).toBeGreaterThanOrEqual(events[i - 1]!.time)
    })
  }
}

/** `restore(snapshot())` then `k` steps equals `k` steps on the original VM. */
function checkRestore(program: Program, at: number, k: number): void {
  const original = freshVM(program)
  original.runUntil(at)
  const snapshot = original.snapshot()
  original.runUntil(at + k)
  const restored = freshVM(program)
  restored.restore(snapshot)
  restored.runUntil(at + k)
  expect(digest(restored)).toBe(digest(original))
  original.restore(snapshot)
  original.runUntil(at + k)
  expect(digest(original)).toBe(digest(restored))
}

const subjects = corpusSubjects()

describe('corpus programs (ARCHITECTURE §10.3)', () => {
  test('enough corpus programs are exercised', () => {
    expect(subjects.length).toBeGreaterThanOrEqual(100)
  })

  test.each(subjects.map((s) => [s.name, s] as const))('%s', (_name, subject) => {
    const n = subject.recording.length
    fc.assert(
      fc.property(fc.integer({ min: 0, max: n }), fc.integer({ min: 0, max: 50 }), (t, k) => {
        checkMoment(subject, t)
        checkRestore(subject.program, t, k)
      }),
      {
        numRuns: 4,
        seed: 42,
        examples: [
          [0, 1],
          [n, 0],
        ],
      },
    )
  })

  test('seeking in random orders gives identical views', () => {
    const picked = subjects.filter((s) => s.recording.length > 200).slice(0, 10)
    fc.assert(
      fc.property(
        fc.constantFrom(...picked),
        fc.array(fc.nat(), { minLength: 2, maxLength: 10 }),
        (subject, picks) => {
          const n = subject.recording.length
          const times = picks.map((p) => p % (n + 1))
          const other = record(subject.program, { maxSteps: CORPUS_STEP_LIMIT, snapshotBudget: 2 })
          const forwardViews = times.map((t) => subject.recording.stateAt(t))
          const reversed = [...times].reverse().map((t) => other.stateAt(t))
          expect(reversed.reverse()).toEqual(forwardViews)
        },
      ),
      { numRuns: 20, seed: 7 },
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Generated programs

const STATEMENTS = [
  'acc += helper(i)',
  'push(xs, i * 3)',
  'if len(xs) > 2 { remove(xs, 0) }',
  'if len(xs) > 0 { xs[0] = {v: i} }',
  'let ys = map(xs, |x| { if type(x) == "number" { x + 1 } else { x } })',
  'acc = acc + count(xs, |x| x == i)',
  'rec[str(i % 3)] = acc',
  'let f = |y| y + i\n  acc = f(acc)',
  'acc += sum(filter(range(0, i), |q| q % 2 == 0))',
  'let sorted = sort_by([3, 1, 2], |z| -z)',
]

const generatedProgram = fc
  .record({
    count: fc.integer({ min: 0, max: 6 }),
    body: fc.array(fc.constantFrom(...STATEMENTS), { minLength: 1, maxLength: 5 }),
  })
  .map(({ count, body }) =>
    [
      'fn helper(n) {',
      '  if n < 2 { return n }',
      '  n * 2',
      '}',
      'var acc = 0',
      'var xs = []',
      'var rec = {}',
      `for i in 0..${count} {`,
      `  ${body.join('\n  ')}`,
      '}',
      'print(acc)',
    ].join('\n'),
  )

describe('generated programs (ARCHITECTURE §10.3)', () => {
  test('seeks, navigation, origin and restore obey their invariants', () => {
    fc.assert(
      fc.property(
        generatedProgram,
        fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
        (source, picks) => {
          const subject = subjectOf(source, 3)
          const n = subject.recording.length
          for (const pick of picks) {
            const t = pick % (n + 1)
            checkMoment(subject, t)
            checkRestore(subject.program, t, pick % 37)
          }
        },
      ),
      { numRuns: 40, seed: 1234 },
    )
  })

  test('step over skips sibling calls', () => {
    // Arrange
    const source = 'fn sq(x) {\n  x * x\n}\nlet a = sq(2) + sq(3)\nprint(a)'
    const { recording } = subjectOf(source)
    const insideFirst = recording.continue(0, 'forward', new Set([2]))

    // Act
    const over = recording.step(insideFirst, 'over', 'forward')

    // Assert: the second call's body (also line 2, depth 1) is not the same activation
    expect(recording.depthAt(insideFirst)).toBe(1)
    expect(recording.locationAt(over)!.stmtLine).toBe(5)
    expect(recording.depthAt(over)).toBe(0)
  })
})
