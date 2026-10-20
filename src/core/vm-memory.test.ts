/**
 * The cumulative allocation budget (SPEC §10.5): R025 `memory limit exceeded` ends runaway
 * allocation long before the host runs out of memory, identically in run(), record() and replay.
 */
import { describe, expect, test } from 'vitest'
import { compile, record, run } from './index'
import type { Program } from './bytecode'
import { getLibrary } from './library'
import { MEMORY_LIMIT } from './values'
import { createVM } from './vm'
import { callNativeOn, nativeMachine } from './testing/vm-harness'
import type { Value } from './runtime-types'
import { addSlow } from './vm-ops-arith'
import { setField, setIndex } from './vm-ops-access'
import { interpolate, listExtend, recordMerge } from './vm-ops-data'
import { VMFailure } from './vm-errors'
import type { MachineState } from './vm-state'

const MEMORY_ERROR = { code: 'R025', message: 'memory limit exceeded' }

/** An infinite loop (it forgot `i += 1`) that keeps 100,001-item copies alive. */
const RUNAWAY_GRID = `let row = list(0..100000)
let grid = []
var i = 0
while i < 10 {
  push(grid, copy(row))
}
print(len(grid))
`

function compiled(source: string): Program {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return result.program
}

function errorOf(source: string): { code: string; message: string; steps: number } {
  const result = run(compiled(source), { maxSteps: 50_000_000 })
  if (result.outcome.kind !== 'error')
    throw new Error(`expected an error, got ${result.outcome.kind}`)
  const { code, message } = result.outcome.error
  return { code, message, steps: result.steps }
}

describe('allocation budget', () => {
  test('the budget is 2^26 units', () => {
    expect(MEMORY_LIMIT).toBe(2 ** 26)
  })

  test('a runaway copy loop ends with R025 in run()', () => {
    const result = run(compiled(RUNAWAY_GRID))
    expect(result.outcome.kind).toBe('error')
    if (result.outcome.kind !== 'error') return
    const start = RUNAWAY_GRID.indexOf('copy(row)')
    const span = { start, end: start + 'copy(row)'.length }
    expect(result.outcome.error).toMatchObject({ ...MEMORY_ERROR, span })
  })

  test('record() fails at the same step and replays deterministically', () => {
    const program = compiled(RUNAWAY_GRID)
    const ran = run(program)
    const recording = record(program)
    expect(recording.outcome).toEqual(ran.outcome)
    expect(recording.length).toBe(ran.steps)
    // Seeking restores snapshots and re-executes; the budget must come back with them.
    const late = recording.stateAt(recording.length)
    expect(late.globals.find((g) => g.name === 'i')?.value).toEqual({ kind: 'number', value: 0 })
    expect(recording.stateAt(Math.floor(recording.length / 2)).frames.length).toBe(1)
  })

  test('snapshots carry the budget: a restored VM fails at the same step', () => {
    const program = compiled(RUNAWAY_GRID)
    const library = getLibrary()
    const options = { builtins: [...library.builtins], libraryProtos: library.protos }
    const vm = createVM(program, options)
    vm.runUntil(2_000)
    const snapshot = vm.snapshot()
    vm.runUntil(10_000_000)
    expect(vm.status).toBe('error')
    const failedAt = vm.time
    vm.restore(snapshot)
    vm.runUntil(10_000_000)
    expect(vm.error).toMatchObject(MEMORY_ERROR)
    expect(vm.time).toBe(failedAt)
  })

  test('a runaway string or str() loop ends with R025', () => {
    const concat = 'let s = repeat("x", 1000000)\nwhile true { let t = s + "y" }'
    expect(errorOf(concat)).toMatchObject(MEMORY_ERROR)
    const interp = 'let s = repeat("x", 1000000)\nwhile true { let t = "{s}!" }'
    expect(errorOf(interp)).toMatchObject(MEMORY_ERROR)
    const strs = 'let xs = list(0..1000000)\nwhile true { let t = str(xs) }'
    expect(errorOf(strs)).toMatchObject(MEMORY_ERROR)
  })

  /** A machine with only `left` units of budget left. */
  function nearlyFull(left: number): MachineState {
    const machine = nativeMachine()
    machine.allocated = MEMORY_LIMIT - left
    return machine
  }

  function failure(action: () => void): unknown {
    try {
      action()
    } catch (caught) {
      if (caught instanceof VMFailure) return { code: caught.code, message: caught.message }
      throw caught
    }
    return null
  }

  test('each allocating operation charges what it creates', () => {
    const m = nearlyFull(3)
    const list = m.newList([1, 2])
    expect(m.allocated).toBe(MEMORY_LIMIT - 1)
    m.appendItem(list, 3)
    expect(failure(() => m.appendItem(list, 4))).toEqual(MEMORY_ERROR)
    expect(list.items).toEqual([1, 2, 3])

    const r = nearlyFull(1)
    const record = r.newRecord(new Map())
    setField(r, record, 'a', 1)
    setField(r, record, 'a', 2) // overwriting an existing key is free
    expect(failure(() => setField(r, record, 'b', 1))).toEqual(MEMORY_ERROR)
    expect(failure(() => setIndex(r, record, 'b', 1))).toEqual(MEMORY_ERROR)
    expect([...record.fields.keys()]).toEqual(['a'])

    const s = nearlyFull(3)
    s.stack.push('ab', 'cd')
    expect(failure(() => interpolate(s, 2))).toEqual(MEMORY_ERROR)
    const t = nearlyFull(3)
    expect(failure(() => addSlow(t, 'ab', 'cd'))).toEqual(MEMORY_ERROR)
  })

  test('spreads and natives charge their results', () => {
    const m = nearlyFull(100)
    m.stack.push(m.newList([]), m.newList([1, 2, 3]))
    m.allocated = MEMORY_LIMIT - 2
    expect(failure(() => listExtend(m))).toEqual(MEMORY_ERROR)

    const r = nearlyFull(100)
    const other = r.newRecord(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]),
    )
    r.stack.push(r.newRecord(new Map()), other)
    r.allocated = MEMORY_LIMIT - 2
    expect(failure(() => recordMerge(r))).toEqual(MEMORY_ERROR)

    const natives: [string, ...Value[]][] = [
      ['repeat', 'ab', 3],
      ['join', ['a', 'b', 'c'] as unknown as Value, '--'],
      ['pad_start', 'a', 10],
      ['upper', 'abcdefgh'],
      ['slice', 'abcdefgh', 1],
      ['str', 12345678],
      ['chars', 'abcdefgh'],
      ['split', 'a,b,c,d,e', ','],
      ['keys', null],
    ]
    for (const [name, ...args] of natives) {
      const n = nearlyFull(100)
      const realArgs = args.map((arg) => {
        if (Array.isArray(arg)) return n.newList(arg as Value[])
        if (name === 'keys')
          return n.newRecord(new Map(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [k, 1])))
        return arg
      })
      n.allocated = MEMORY_LIMIT - 5
      const result = callNativeOn(n, name, ...realArgs)
      expect(result, name).toMatchObject({ ok: false, ...MEMORY_ERROR })
    }
  })

  test('ordinary programs stay far below the budget', () => {
    const result = run(
      compiled('var xs = []\nfor i in 0..100000 { push(xs, "item {i}") }\nprint(len(xs))'),
    )
    expect(result.outcome.kind).toBe('finished')
  })
})
