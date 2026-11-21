import { describe, expect, test } from 'vitest'
import type { CompileResult, RecordOptions, Recording } from './api-types'
import type { Program } from './bytecode'
import { callTree } from './calls'
import { type FunctionContracts, inferContractsWith, type InferOptions } from './infer'
import { clauseTexts, compile, inferContracts, record, withContracts } from './index'

function recorded(source: string, options: RecordOptions = {}): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => d.message).join('; '))
  return record(compiled.program, options)
}

function inferred(source: string, options: InferOptions = {}) {
  const recording = recorded(source)
  return inferContracts(recording, callTree(recording), options)
}

function fnNamed(functions: readonly FunctionContracts[], name: string): FunctionContracts {
  const found = functions.find((f) => f.name === name)
  if (found === undefined) throw new Error(`no function ${name}`)
  return found
}

function clauses(f: FunctionContracts): string[] {
  return f.suggestions.map((s) => `${s.kind} ${s.clause}`)
}

const NUMBERS = `fn double_plus_one(x) { 2 * x + 1 }
fn add(a, b) { a + b }
fn square(n) { n * n }
for i in [1, 2, 3, 5] { print(double_plus_one(i), square(i)) }
print(add(1, 2), add(3, 4), add(10, 20))
`

const LISTS = `fn sorted(xs) { sort(xs) }
fn biggest(xs) { max(xs) }
fn evens(xs) { filter(xs, |x| x % 2 == 0) }
fn first(xs) { xs[0] }
print(sorted([3, 1, 2]), sorted([5, 4]), sorted([9]))
print(biggest([3, 1, 2]), biggest([5, 4]), biggest([9]))
print(evens([1, 2, 3, 4]), evens([4, 6, 8]), evens([2, 5, 6]))
print(first([1, 3]), first([7]), first([5, 2, 9]))
`

describe('inferContracts: what is suggested', () => {
  test('finds small-integer linear relations and pins the result with them', () => {
    // Arrange / Act
    const result = inferred(NUMBERS)

    // Assert
    const f = fnNamed(result.functions, 'double_plus_one')
    expect(clauses(f)).toContain('ensures result == 2 * x + 1')
    const linear = f.suggestions.find((s) => s.template === 'linear')!
    expect(linear.pins).toBe(true)
    expect(linear.support).toEqual({ calls: 4, inputs: 4 })
    expect(linear.example.text).toBe('double_plus_one(x = 1) returned 3')
  })

  test('relates two parameters arithmetically and keeps their preconditions', () => {
    // Arrange / Act
    const result = inferred(NUMBERS)

    // Assert
    expect(clauses(fnNamed(result.functions, 'add'))).toEqual([
      'ensures result == a + b',
      'requires a > 0',
      'requires b > 0',
    ])
  })

  test('drops postconditions a pinning clause makes redundant but keeps order without one', () => {
    // Arrange / Act
    const result = inferred(NUMBERS)

    // Assert
    const square = clauses(fnNamed(result.functions, 'square'))
    expect(square).toContain('ensures result >= n')
    expect(square).toContain('requires n > 0')
    expect(square).not.toContain('requires type(n) == "number"')
  })

  test('suggests builtin images, membership and length relations for list functions', () => {
    // Arrange / Act
    const result = inferred(LISTS)

    // Assert
    expect(clauses(fnNamed(result.functions, 'sorted'))).toEqual([
      'ensures result == sort(xs)',
      'requires len(xs) > 0',
      'requires type(xs) == "list"',
    ])
    expect(clauses(fnNamed(result.functions, 'biggest'))).toContain('ensures result == max(xs)')
    const evens = clauses(fnNamed(result.functions, 'evens'))
    expect(evens).toContain('ensures len(result) <= len(xs)')
    expect(evens).toContain('ensures all(result, |x| contains(xs, x))')
    expect(evens).toContain('ensures result == sort(result)')
    expect(clauses(fnNamed(result.functions, 'first'))).toContain('ensures contains(xs, result)')
  })

  test('says why a function with too few different inputs gets nothing', () => {
    // Arrange
    const source = `fn f(x) { x + 1 }
fn never(y) { y }
print(f(1), f(1), f(2))
`

    // Act
    const result = inferred(source)

    // Assert
    expect(fnNamed(result.functions, 'f').note).toBe(
      'returned with 2 different inputs; at least 3 are needed',
    )
    expect(fnNamed(result.functions, 'f').calls).toBe(3)
    expect(fnNamed(result.functions, 'never').note).toBe('never returned in this run')
  })

  test('lowers the bar with minInputs and narrows to one function with fn', () => {
    // Arrange
    const source = `fn f(x) { x + 1 }
fn g(y) { y }
print(f(1), f(2), g(5), g(6))
`

    // Act
    const result = inferred(source, { fn: 'f', minInputs: 2 })

    // Assert
    expect(result.functions.map((f) => f.name)).toEqual(['f'])
    expect(clauses(result.functions[0]!)).toContain('requires x > 0')
  })

  test('does not suggest a clause the function already has', () => {
    // Arrange
    const source = `fn add(a, b)
  ensures result == a + b
{
  a + b
}
print(add(1, 2), add(3, 4), add(10, 20))
`

    // Act
    const f = fnNamed(inferred(source).functions, 'add')

    // Assert
    expect(f.existing).toEqual(['result == a + b'])
    expect(clauses(f)).not.toContain('ensures result == a + b')
  })

  test('finds types, string images and equality with a parameter', () => {
    // Arrange
    const source = `fn shout(s) { upper(s) }
fn pick(a, b) { if len(a) >= len(b) { a } else { b } }
fn name_of(r) { r.name }
print(shout("a"), shout("bc"), shout("Hi"))
print(pick("aa", "b"), pick("xyz", "q"), pick("hello", ""))
print(name_of({name: "x"}), name_of({name: "y"}), name_of({name: "z"}))
`

    // Act
    const result = inferred(source)

    // Assert
    expect(clauses(fnNamed(result.functions, 'shout'))).toContain('ensures result == upper(s)')
    const pick = clauses(fnNamed(result.functions, 'pick'))
    expect(pick).toContain('ensures result == a')
    const nameOf = clauses(fnNamed(result.functions, 'name_of'))
    expect(nameOf).toContain('requires type(r) == "record"')
    expect(nameOf).toContain('ensures type(result) == "string"')
    expect(nameOf).not.toContain('ensures len(result) == len(r)')
  })

  test('says a mixed-type variable is never nil and finds negative signs', () => {
    // Arrange
    const source = `fn wrap(v) { [v] }
fn neg(n) { 0 - n * n - 1 }
print(wrap(1), wrap("a"), wrap(true))
print(neg(1), neg(2), neg(3))
`

    // Act
    const result = inferred(source)

    // Assert
    const wrap = clauses(fnNamed(result.functions, 'wrap'))
    expect(wrap).toContain('requires v != nil')
    expect(wrap).toContain('ensures len(result) > 0')
    expect(clauses(fnNamed(result.functions, 'neg'))).toContain('ensures result < 0')
  })

  test('relates the length of a list result to a length linearly', () => {
    // Arrange
    const source = `fn twice(xs) { xs + xs }
fn join2(a, b) { a + b }
print(twice([1]), twice([1, 2]), twice([3, 4, 5]))
print(join2("a", "b"), join2("c", "dd"), join2("e", "fff"))
`

    // Act
    const result = inferred(source)

    // Assert
    expect(clauses(fnNamed(result.functions, 'twice'))).toContain(
      'ensures len(result) == 2 * len(xs)',
    )
    expect(clauses(fnNamed(result.functions, 'join2'))).toContain('ensures result == a + b')
  })

  test('caps the suggestions per function', () => {
    // Arrange / Act
    const result = inferred(NUMBERS, { maxPerFunction: 1 })

    // Assert
    expect(result.functions.every((f) => f.suggestions.length <= 1)).toBe(true)
  })
})

describe('inferContracts: the check', () => {
  test('every verified suggestion compiles and holds when written in', () => {
    // Arrange
    const recording = recorded(LISTS)
    const result = inferContracts(recording, callTree(recording))

    // Act
    const source = withContracts(recording.program.source, result.functions)
    const again = recorded(source)

    // Assert
    expect(result.verified).toBe(true)
    expect(again.outcome.kind).toBe('finished')
    expect(again.outputs.map((o) => o.text)).toEqual(recording.outputs.map((o) => o.text))
  })

  test('withdraws a clause that held in the calls read but fails elsewhere in the run', () => {
    // Arrange: with three calls read of five, the negative argument is not among them.
    const source = `fn inc(x) { x + 1 }
print(inc(1), inc(2), inc(-5), inc(3), inc(4))
`

    // Act
    const result = inferred(source, { maxCalls: 3 })

    // Assert
    const inc = fnNamed(result.functions, 'inc')
    expect(inc.sampled).toBe(3)
    expect(clauses(inc)).not.toContain('requires x > 0')
    expect(clauses(inc)).toContain('ensures result == x + 1')
    expect(result.withdrawn).toBeGreaterThan(0)
    expect(result.verified).toBe(true)
  })

  test('skips the check when asked and reports the suggestions unverified', () => {
    // Arrange / Act
    const result = inferred(NUMBERS, { verify: false })

    // Assert
    expect(result.verified).toBe(false)
    expect(result.withdrawn).toBe(0)
    expect(fnNamed(result.functions, 'add').suggestions.length).toBeGreaterThan(0)
  })

  test('withdraws everything when the program behaves differently with the clauses', () => {
    // Arrange
    const recording = recorded(NUMBERS)
    const other = recorded('print("something else")')
    const tools = {
      compile: (source: string): CompileResult => compile(source),
      record: (_program: Program, _options: RecordOptions): Recording => other,
    }

    // Act
    const result = inferContractsWith(tools, callTree(recording))

    // Assert
    expect(result.verified).toBe(false)
    expect(result.problem).toContain('behaved differently')
    expect(result.functions.every((f) => f.suggestions.length === 0)).toBe(true)
    expect(fnNamed(result.functions, 'add').note).toBe('the suggestions could not be checked')
  })

  test('withdraws a clause the compiler rejects', () => {
    // Arrange: a parameter named like a builtin makes `len(...)` a call of a number.
    const source = `fn count(len, xs) { len + 1 }
print(count(1, [1]), count(2, [1, 2]), count(3, [4, 5, 6]))
`

    // Act
    const result = inferred(source)

    // Assert
    const count = fnNamed(result.functions, 'count')
    expect(result.verified).toBe(true)
    for (const clause of clauses(count)) expect(clause).not.toContain('len(xs)')
  })

  test('compares only the output so far when the run was cut short', () => {
    // Arrange
    const source = `fn step(n) { n + 2 }
var i = 0
while true { i = step(i)
  print(i) }
`
    const recording = recorded(source, { maxSteps: 400 })

    // Act
    const result = inferContracts(recording, callTree(recording))

    // Assert
    expect(recording.outcome.kind).toBe('step-limit')
    expect(result.verified).toBe(true)
    expect(clauses(fnNamed(result.functions, 'step'))).toContain('ensures result == n + 2')
  })

  test('keeps the same error as a run that failed', () => {
    // Arrange
    const source = `fn half(n) { n / 2 }
print(half(2), half(4), half(8))
panic("done")
`

    // Act
    const result = inferred(source)

    // Assert
    expect(result.verified).toBe(true)
    expect(clauses(fnNamed(result.functions, 'half'))).toContain('requires n > 0')
  })

  test('refuses a call tree of another recording', () => {
    // Arrange
    const a = recorded(NUMBERS)
    const b = recorded(NUMBERS)

    // Act / Assert
    expect(() => inferContracts(a, callTree(b))).toThrow('another recording')
  })
})

describe('clauseTexts and withContracts', () => {
  test('writes preconditions before postconditions', () => {
    // Arrange
    const result = inferred(NUMBERS)
    const add = fnNamed(result.functions, 'add')

    // Act
    const texts = clauseTexts(add.suggestions)

    // Assert
    expect(texts.map((t) => t.kind)).toEqual(['requires', 'requires', 'ensures'])
    expect(withContracts(NUMBERS, [add])).toContain(
      'fn add(a, b)\n  requires a > 0\n  requires b > 0\n  ensures result == a + b\n{ a + b }',
    )
  })
})
