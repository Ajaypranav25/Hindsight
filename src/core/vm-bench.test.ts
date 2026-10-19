import { expect, test } from 'vitest'
import { startAsm } from './testing/vm-harness'

/** `var i = 0; while i < LIMIT { i = i + 1 }`: 9 instructions per iteration. */
const COUNTING_LOOP = `
Const 0
Declare 1
@loop: GetLocal 1
Const 555555
Lt
JumpIfFalse @end
GetLocal 1
Const 1
Add
SetLocal 1
Jump @loop
@end: Nil
Return`

const BUDGET_MS = 4000

test('a counting loop of about 5,000,000 instructions runs well within budget', () => {
  const run = startAsm(COUNTING_LOOP, { hooks: false })
  const started = performance.now()
  run.vm.runUntil(Infinity)
  const elapsed = performance.now() - started
  expect(run.vm.status).toBe('finished')
  expect(run.vm.time).toBeGreaterThan(4_999_000)
  expect(elapsed).toBeLessThan(BUDGET_MS)
})

test('stepping one instruction at a time is also fast', () => {
  const run = startAsm(COUNTING_LOOP, { hooks: false })
  const started = performance.now()
  const vm = run.vm
  while (vm.status === 'running') vm.step()
  expect(vm.time).toBeGreaterThan(4_999_000)
  expect(performance.now() - started).toBeLessThan(BUDGET_MS)
})
