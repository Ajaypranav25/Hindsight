import { describe, expect, test } from 'vitest'
import { digest } from './testing/vm-digest'
import { runAsm, startAsm, testBuiltins } from './testing/vm-harness'
import { createVM } from './vm'
import type { ListObj } from './runtime-types'
import { MachineSnapshot } from './vm-snapshot'

/** Allocates, mutates lists and records, closes cells, iterates and draws random numbers. */
const BUSY = `
List 0
Declare 1
Const 0
Const 6
Range 0
IterInit
@next: IterNext @done
Declare 1
GetBuiltin push
GetLocal 1
Closure grab local 3
Call 2
Pop
GetBuiltin push
GetLocal 1
GetBuiltin random_int
Const 1
Const 100
Call 2
Call 2
Pop
Const "k"
GetLocal 3
Record 1
Pop
PopN 1
Jump @next
@done: Pop
GetBuiltin print
GetLocal 1
GetBuiltin random
Call 0
Call 2
Pop
Nil
Return
.fn grab upvalues=1
GetUpvalue 0
Return
.end`

describe('snapshots (ARCHITECTURE §6.8)', () => {
  test('restore then k steps equals k steps on the original, at every k', () => {
    const original = startAsm(BUSY)
    original.vm.runUntil(20)
    const snapshot = original.vm.snapshot()
    expect(snapshot.time).toBe(20)
    // The recorder resumes in a fresh VM of the same program.
    const replica = {
      vm: createVM(original.program, { builtins: testBuiltins(), libraryProtos: [] }),
    }
    replica.vm.restore(snapshot)
    while (original.vm.status === 'running') {
      expect(digest(replica.vm)).toBe(digest(original.vm))
      original.vm.step()
      replica.vm.step()
    }
    expect(digest(replica.vm)).toBe(digest(original.vm))
    expect(replica.vm.status).toBe('finished')
  })

  test('a snapshot is independent of later mutation and can be restored repeatedly', () => {
    const run = startAsm(BUSY)
    run.vm.runUntil(30)
    const snapshot = run.vm.snapshot()
    const before = digest(run.vm)
    run.vm.runUntil(Infinity)
    run.vm.restore(snapshot)
    expect(digest(run.vm)).toBe(before)
    run.vm.runUntil(Infinity)
    run.vm.restore(snapshot)
    expect(digest(run.vm)).toBe(before)
  })

  test('restored objects are fresh copies with the same ids', () => {
    const run = startAsm('Const 1\nList 1\nDeclare 1\nNil\nReturn')
    run.vm.runUntil(3)
    const list = run.vm.stack[1] as ListObj
    run.vm.restore(run.vm.snapshot())
    const restored = run.vm.stack[1] as ListObj
    expect(restored).not.toBe(list)
    expect(restored.id).toBe(list.id)
    expect(restored.items).toEqual([1])
  })

  test('size counts the values copied', () => {
    const sized = (count: number): number => {
      const run = startAsm(`GetBuiltin list\nConst 0\nConst ${count}\nRange 0\nCall 1\nNil\nReturn`)
      run.vm.runUntil(5)
      return run.vm.snapshot().size
    }
    expect(sized(1000) - sized(0)).toBe(1000)
  })

  test('restore rejects snapshots of other programs', () => {
    const a = startAsm('Nil\nReturn')
    const b = startAsm('Nil\nReturn')
    expect(() => a.vm.restore(b.vm.snapshot())).toThrow(/internal error/)
    expect(() => a.vm.restore({ time: 0, size: 0 })).toThrow(/internal error/)
  })

  test('the generator state is part of the snapshot', () => {
    const run = startAsm('GetBuiltin random\nCall 0\nGetBuiltin random\nCall 0\nNil\nReturn')
    const snapshot = run.vm.snapshot()
    expect(snapshot).toBeInstanceOf(MachineSnapshot)
    run.vm.runUntil(4)
    const first = [...run.vm.stack]
    run.vm.restore(snapshot)
    run.vm.runUntil(4)
    expect(run.vm.stack).toEqual(first)
  })
})

/** Builds a list nested `depth` deep in a global `xs` with a loop, then runs `tail`. */
function deepProgram(depth: number, tail: string): string {
  return `
List 0
DefineGlobal xs
Const 0
Const ${depth}
Range 0
IterInit
@next: IterNext @done
Pop
GetGlobal xs
List 1
SetGlobal xs
Jump @next
@done: Pop
${tail}
Nil
Return`
}

describe('deeply nested data never overflows the JavaScript stack', () => {
  const depth = 100_000

  test('repr, equality and snapshots of a 100,000-deep list', () => {
    const tail = `GetBuiltin print
GetBuiltin len
GetBuiltin repr
GetGlobal xs
Call 1
Call 1
GetGlobal xs
GetGlobal xs
Eq
Call 2
Pop`
    const run = startAsm(deepProgram(depth, tail))
    run.vm.runUntil(depth * 6)
    const snapshot = run.vm.snapshot()
    run.vm.restore(snapshot)
    run.vm.runUntil(Infinity)
    expect(run.vm.error).toBeNull()
    expect(run.events.filter((e) => e.e === 'output')).toEqual([
      expect.objectContaining({ text: `${2 * depth + 2} true` }),
    ])
  })

  test('comparing two distinct deep lists is structural', () => {
    const tail = `GetGlobal xs
DefineGlobal ys
List 0
DefineGlobal xs
Const 0
Const ${depth}
Range 0
IterInit
@n2: IterNext @d2
Pop
GetGlobal xs
List 1
SetGlobal xs
Jump @n2
@d2: Pop
GetBuiltin print
GetGlobal xs
GetGlobal ys
Eq
Call 1
Pop`
    const run = runAsm(deepProgram(depth, tail), { maxSteps: Infinity })
    expect(run.outputs).toEqual(['true'])
  })
})

function outputs(text: string, options: { seed?: number } = {}): string[] {
  return runAsm(text, options).outputs
}

describe('the generator (SPEC §10.3)', () => {
  function mulberry32(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const DRAWS = `GetBuiltin print
GetBuiltin random
Call 0
GetBuiltin random
Call 0
GetBuiltin random_int
Const 1
Const 6
Call 2
Call 3
Pop`

  test('random and random_int follow mulberry32 seeded with 42 by default', () => {
    const reference = mulberry32(42)
    const a = reference()
    const b = reference()
    const c = 1 + Math.floor(reference() * 6)
    expect(outputs(`${DRAWS}\nNil\nReturn`)).toEqual([`${a} ${b} ${c}`])
  })

  test('options.seed and seed(n) reset the state with ToUint32', () => {
    const reference = mulberry32(7)
    const expected = `${reference()} ${reference()} ${1 + Math.floor(reference() * 6)}`
    expect(outputs(`${DRAWS}\nNil\nReturn`, { seed: 7 })).toEqual([expected])
    expect(
      outputs(`GetBuiltin seed\nConst ${2 ** 32 + 7}\nCall 1\nPop\n${DRAWS}\nNil\nReturn`),
    ).toEqual([expected])
    expect(outputs(`GetBuiltin seed\nConst 7.9\nCall 1\nPop\n${DRAWS}\nNil\nReturn`)).toEqual([
      expected,
    ])
    const negative = mulberry32(-1)
    expect(
      outputs(
        `GetBuiltin seed\nConst -1\nCall 1\nPop\nGetBuiltin print\nGetBuiltin random\nCall 0\nCall 1\nPop\nNil\nReturn`,
      ),
    ).toEqual([`${negative()}`])
  })
})
