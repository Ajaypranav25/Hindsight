/**
 * Wall-clock budgets for "did you mean" hints on large programs and records (`npm run test:perf`;
 * `npm test` skips this file). The pruned search must stay far from quadratic.
 */
import { expect, test } from 'vitest'
import { compile, run } from './index'

const BUDGET_MS = 3000

test('many functions and many undefined names compile quickly', () => {
  const lines: string[] = []
  for (let i = 0; i < 1000; i++) lines.push(`fn function_number_${i}(x) { x }`)
  for (let i = 0; i < 500; i++) lines.push(`print(function_numbr_${i}(1), undefined_thing_${i})`)
  const started = performance.now()
  const result = compile(lines.join('\n'))
  const elapsed = performance.now() - started
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.diagnostics.length).toBe(1000)
  expect(result.diagnostics[0]!.hint).toBe("did you mean 'function_number_0'?")
  expect(elapsed).toBeLessThan(BUDGET_MS)
})

test('a missing field of a huge record with long keys fails quickly', () => {
  const prefix = 'k'.repeat(75)
  const source = `let p = "${prefix}"
let r = {}
for i in 0..20000 { r["{p}_{i + 100000}"] = i }
print(r.${prefix}_x00000)`
  const compiled = compile(source)
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
  const started = performance.now()
  const result = run(compiled.program)
  const elapsed = performance.now() - started
  expect(result.outcome.kind).toBe('error')
  if (result.outcome.kind !== 'error') return
  expect(result.outcome.error.code).toBe('R010')
  expect(result.outcome.error.hint).toBe(`did you mean '${prefix}_100000'?`)
  expect(elapsed).toBeLessThan(BUDGET_MS)
})
