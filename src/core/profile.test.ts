import { describe, expect, test } from 'vitest'
import type { Recording } from './api-types'
import { compile, record } from './index'
import { foldedText, profile, type ProfileNode } from './profile'

function recorded(source: string, maxSteps?: number): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => d.message).join('; '))
  return record(compiled.program, maxSteps === undefined ? {} : { maxSteps })
}

function sumSelf(root: ProfileNode): number {
  let total = 0
  const work = [root]
  for (let node = work.pop(); node !== undefined; node = work.pop()) {
    total += node.self
    work.push(...node.children)
  }
  return total
}

const FIB = `fn fib(n) {
  if n < 2 { return n }
  fib(n - 1) + fib(n - 2)
}
fn main() {
  var total = 0
  for i in 0..5 {
    total += fib(i)
  }
  total
}
print(main())
`

const MAPPED = `fn double(x) { x * 2 }
let ys = map([1, 2, 3], |x| double(x))
print(ys)
`

describe('profile', () => {
  test('accounts for every step exactly once as exclusive steps', () => {
    // Arrange
    const recording = recorded(FIB)

    // Act
    const result = profile(recording)

    // Assert
    expect(result.steps).toBe(recording.length)
    const exclusive = result.functions.reduce((sum, fn) => sum + fn.exclusive, 0)
    expect(exclusive).toBe(recording.length)
    expect(sumSelf(result.root)).toBe(recording.length)
    expect(result.root.inclusive).toBe(recording.length)
  })

  test('counts a recursive function once in its inclusive steps', () => {
    // Arrange
    const recording = recorded(FIB)

    // Act
    const result = profile(recording)
    const fib = result.functions.find((fn) => fn.name === 'fib')!
    const main = result.functions.find((fn) => fn.name === 'main')!

    // Assert
    expect(fib.calls).toBe(1 + 1 + 3 + 5 + 9)
    expect(fib.inclusive).toBeLessThanOrEqual(main.inclusive)
    expect(fib.inclusive).toBeGreaterThan(fib.exclusive - 1)
    expect(fib.max).toBeGreaterThan(fib.average)
    expect(fib.lines).toEqual({ start: 1, end: 4 })
    expect(result.functions[0]!.name).toBe('<top level>')
  })

  test('lists folded stacks whose steps add up to the run', () => {
    // Arrange
    const recording = recorded(FIB)

    // Act
    const { folded } = profile(recording)
    const text = foldedText(folded)

    // Assert
    expect(folded.reduce((sum, entry) => sum + entry.steps, 0)).toBe(recording.length)
    expect(text.split('\n')[0]).toMatch(/^<top level> \d+$/)
    expect(text).toContain('<top level>;main;fib;fib ')
  })

  test('folds library calls into their user caller with just-my-code', () => {
    // Arrange
    const recording = recorded(MAPPED)

    // Act
    const full = profile(recording)
    const mine = profile(recording, { justMyCode: true })

    // Assert
    expect(full.functions.some((fn) => fn.name === 'map' && fn.library)).toBe(true)
    expect(mine.functions.some((fn) => fn.library)).toBe(false)
    const lambda = mine.root.children.find((node) => node.label === 'lambda@2')!
    expect(lambda.calls).toBe(3)
    expect(lambda.children[0]!.label).toBe('double')
    expect(mine.functions.reduce((sum, fn) => sum + fn.exclusive, 0)).toBe(recording.length)
    expect(foldedText(mine.folded)).toContain('<top level>;lambda@2;double 12')
  })

  test('attributes library steps to the calling line with just-my-code', () => {
    // Arrange
    const recording = recorded(MAPPED)

    // Act
    const full = profile(recording)
    const mine = profile(recording, { justMyCode: true })
    const total = (lines: readonly { steps: number }[]) =>
      lines.reduce((sum, line) => sum + line.steps, 0)

    // Assert
    expect(full.libraryLineSteps).toBeGreaterThan(0)
    expect(total(full.lines) + full.libraryLineSteps).toBe(recording.length)
    expect(mine.libraryLineSteps).toBe(0)
    expect(total(mine.lines)).toBe(recording.length)
    expect(mine.lines[0]!.line).toBe(2)
  })

  test('skips the line pass when lines are not wanted', () => {
    // Arrange
    const recording = recorded(FIB)

    // Act
    const result = profile(recording, { lines: false })

    // Assert
    expect(result.lines).toEqual([])
    expect(result.libraryLineSteps).toBe(0)
  })

  test('counts calls cut off by an error or the step limit up to the end', () => {
    // Arrange
    const crashed = recorded('fn f(x) { 1 / 0 }\nfn g() { f(1) }\ng()\n')
    const limited = recorded('fn spin() { while true { } }\nspin()\n', 200)

    // Act
    const crash = profile(crashed)
    const limit = profile(limited)

    // Assert
    expect(crash.functions.reduce((sum, fn) => sum + fn.exclusive, 0)).toBe(crashed.length)
    expect(crash.functions.find((fn) => fn.name === 'g')!.inclusive).toBeGreaterThan(0)
    const spin = limit.functions.find((fn) => fn.name === 'spin')!
    expect(spin.inclusive).toBe(limited.length - spin.firstEntry)
  })

  test('profiles an empty program', () => {
    // Arrange
    const recording = recorded('')

    // Act
    const result = profile(recording)

    // Assert
    expect(result.root.label).toBe('<top level>')
    expect(result.root.inclusive).toBe(recording.length)
  })

  test('walks deep recursion without overflowing the JavaScript stack', () => {
    // Arrange
    const recording = recorded(
      'fn d(n) { if n == 0 { 0 } else { 1 + d(n - 1) } }\nprint(d(5000))\n',
    )

    // Act
    const result = profile(recording, { lines: false })

    // Assert
    const d = result.functions.find((fn) => fn.name === 'd')!
    expect(d.calls).toBe(5001)
    expect(d.inclusive).toBe(d.max)
    expect(result.folded.length).toBeGreaterThan(5000)
  })
})
