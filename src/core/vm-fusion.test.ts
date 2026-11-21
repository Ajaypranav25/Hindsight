import { describe, expect, test } from 'vitest'
import type { Program } from './bytecode'
import type { RuntimeDeps, VM } from './runtime-types'
import { compileMain, testRuntime } from './testing/recording'
import { digest } from './testing/vm-digest'

/**
 * Fused dispatch (ARCHITECTURE §6.10) runs some pairs of instructions in one go when the budget of
 * `runUntil` covers both. Stepping one instruction at a time never fuses, so it is the reference.
 */
const PROGRAMS: Record<string, string> = {
  locals: [
    'fn count(n) {',
    '  var i = 0',
    '  var t = 0',
    '  while i < n {',
    '    t = t + i * 2',
    '    if t > 10 { t = t - 10 }',
    '    if t <= 3 { t = t + 1 }',
    '    if i >= 4 { t = t - 1 }',
    '    i += 1',
    '  }',
    '  t',
    '}',
    'print(count(12))',
  ].join('\n'),
  fields: [
    'fn norm(p) { p.x * p.x + p.y * p.y }',
    'var total = 0',
    'for i in 0..6 { total = total + norm({x: i, y: 1}) }',
    'print(total)',
  ].join('\n'),
  strings: [
    'fn label(s) { s + "!" }',
    'fn shorter(n) { n - 1 }',
    'var out = ""',
    'for w in ["a", "b"] { out = out + label(w) }',
    'print(out, shorter(3))',
  ].join('\n'),
}

/** Programs whose error happens in the second instruction of a fused pair. */
const FAILING: Record<string, string> = {
  constAdd: 'let x = nil\nprint(x + 1)',
  constAddString: 'let s = "a"\nprint(s + 1)',
  constSub: 'let n = true\nprint(n - 1)',
  localConstAdd: 'fn f(x) { x + 1 }\nprint(f(nil))',
  localConstSub: 'fn g(a) { a - 1 }\ng("s")',
  getFieldOnNumber: 'fn h(p) { p.x }\nh(3)',
  getFieldMissing: 'fn h(p) { p.y }\nh({x: 1})',
  compareMixed: 'fn c(a, b) { if a < b { 1 } else { 2 } }\nc(1, "x")',
}

function newVM(program: Program, runtime: RuntimeDeps): VM {
  return runtime.createVM(program, { builtins: runtime.builtins, libraryProtos: [] })
}

/** The states after each single step (index k: after k steps), and the final VM. */
function stepByStep(program: Program, runtime: RuntimeDeps): { states: string[]; vm: VM } {
  const vm = newVM(program, runtime)
  const states = [digest(vm)]
  while (vm.status === 'running') {
    vm.step()
    states.push(digest(vm))
  }
  return { states, vm }
}

describe('fused dispatch keeps step semantics', () => {
  for (const [name, source] of Object.entries(PROGRAMS)) {
    test(`${name}: runUntil(k) equals k single steps, at every k`, () => {
      // Arrange
      const program = compileMain(source)
      const runtime = testRuntime()
      const reference = stepByStep(program, runtime)

      // Act + Assert: every k, including those that split a fused pair.
      for (let k = 0; k < reference.states.length; k++) {
        const vm = newVM(program, runtime)
        vm.runUntil(k)
        expect(vm.time).toBe(k)
        expect(digest(vm)).toBe(reference.states[k])
      }
    })
  }

  test('a run in chunks of two stops exactly at each limit', () => {
    const program = compileMain(PROGRAMS.locals!)
    const runtime = testRuntime()
    const vm = newVM(program, runtime)
    for (let limit = 1; vm.status === 'running'; limit += 2) {
      vm.runUntil(limit)
      if (vm.status === 'running') expect(vm.time).toBe(limit)
    }
    expect(vm.status).toBe('finished')
  })

  for (const [name, source] of Object.entries(FAILING)) {
    test(`${name}: an error in a fused pair reports exactly as unfused`, () => {
      // Arrange
      const program = compileMain(source)
      const runtime = testRuntime()
      const reference = stepByStep(program, runtime).vm

      // Act
      const fused = newVM(program, runtime)
      fused.runUntil(Infinity)

      // Assert
      expect(reference.status).toBe('error')
      expect(fused.status).toBe('error')
      expect(fused.time).toBe(reference.time)
      expect(fused.error).toEqual(reference.error)
      expect(fused.frames.map((frame) => frame.ip)).toEqual(reference.frames.map((f) => f.ip))
    })
  }
})
