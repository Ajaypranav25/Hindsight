import { describe, expect, test } from 'vitest'
import { compile, errorSlice, record, type Recording, run, whyNot } from './index'

function compiled(source: string) {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return result.program
}

function recorded(source: string): Recording {
  return record(compiled(source), {})
}

/** The steps whose statement starts on `line`, in user code. */
function hits(recording: Recording, line: number): readonly number[] {
  return recording.lineHits(line)
}

const AVERAGE = `fn average(xs)
  requires len(xs) > 0
  ensures result >= 0
{
  let total = sum(xs)
  total / len(xs)
}
print(average([2, 4]))
print(average([]))
`

describe('contracts at run time (SPEC §7.16)', () => {
  test('a failed precondition is R026 at the clause, with the arguments in the hint', () => {
    // Arrange
    const recording = recorded(AVERAGE)

    // Act
    const outcome = recording.outcome

    // Assert
    if (outcome.kind !== 'error') throw new Error('expected an error')
    expect(outcome.error).toMatchObject({
      code: 'R026',
      message: 'precondition failed: len(xs) > 0',
      hint: 'the caller passed xs = []',
      span: { start: AVERAGE.indexOf('len(xs) > 0'), end: AVERAGE.indexOf('len(xs) > 0') + 11 },
    })
    expect(outcome.error.stack.map((entry) => entry.name)).toEqual(['average', '<top level>'])
    expect(recording.outputs.map((output) => output.text)).toEqual(['3'])
  })

  test('run and record agree on a contract failure', () => {
    // Arrange
    const program = compiled(AVERAGE)

    // Act
    const fast = run(program)
    const recording = record(program, {})

    // Assert
    expect(fast.outcome.kind).toBe('error')
    if (fast.outcome.kind !== 'error' || recording.outcome.kind !== 'error') return
    expect(fast.outcome.error.code).toBe(recording.outcome.error.code)
    expect(fast.outcome.error.time).toBe(recording.length)
  })

  test('long argument values are cut in the hint like reprs in R014', () => {
    // Arrange
    const source = 'fn f(xs) requires len(xs) < 3 { xs }\nf(times(40, |i| i))'

    // Act
    const outcome = recorded(source).outcome

    // Assert
    if (outcome.kind !== 'error') throw new Error('expected an error')
    const hint = outcome.error.hint ?? ''
    expect(hint.startsWith('the caller passed xs = [0, 1, 2')).toBe(true)
    expect(hint.endsWith('…')).toBe(true)
    expect(hint.length).toBe('the caller passed xs = '.length + 60)
  })

  test('stepping visits each clause as a statement', () => {
    // Arrange
    const recording = recorded(AVERAGE)

    // Act / Assert: both calls check the precondition; only the first returns through ensures.
    expect(hits(recording, 2)).toHaveLength(2)
    expect(hits(recording, 3)).toHaveLength(1)
    const ensures = hits(recording, 3)[0]!
    const back = recording.step(ensures, 'into', 'backward')
    expect(recording.locationAt(back)?.stmtLine).toBe(6)
    const first = hits(recording, 2)[0]!
    expect(recording.locationAt(recording.step(first, 'into', 'forward'))?.stmtLine).toBe(5)
  })

  test('while the ensures clause runs, result is a local holding the returned value', () => {
    // Arrange
    const recording = recorded(AVERAGE)
    const ensures = hits(recording, 3)[0]!

    // Act
    const frame = recording.stateAt(ensures).frames.at(-1)!

    // Assert
    expect(frame.name).toBe('average')
    const result = frame.locals.find((local) => local.name === 'result')
    expect(result).toMatchObject({ kind: 'result', value: { kind: 'number', value: 3 } })
    expect(recording.origin(result!.target, ensures + 1)?.kind).toBe('declare')
  })

  test('the slice of a failed postcondition reaches the values its clause read', () => {
    // Arrange
    const source = `fn scale(x, k)
  ensures result == x * k
{
  let doubled = x + x
  doubled
}
let factor = 3
let noise = 7
print(noise)
print(scale(5, factor))
`
    const recording = recorded(source)

    // Act
    const slice = errorSlice(recording)

    // Assert
    expect(recording.outcome).toMatchObject({ kind: 'error', error: { code: 'R027' } })
    expect(slice).not.toBeNull()
    // Not the unrelated lines 8 and 9.
    expect([...slice!.lines].sort((a, b) => a - b)).toEqual([1, 2, 4, 5, 6, 7, 10])
  })

  test('a precondition failure explains why the body never ran', () => {
    // Arrange
    const source = `fn average(xs)
  requires len(xs) > 0
{
  let total = sum(xs)
  total / len(xs)
}
print(average([]))
`
    const recording = recorded(source)

    // Act
    const why = whyNot(recording, 4)

    // Assert
    expect(why).toMatchObject({ kind: 'cut-short', time: recording.length })
    expect(why.sentence).toBe(
      `Line 4 never ran: average was called, but at step ${recording.length} the precondition \`len(xs) > 0\` of average (line 2) failed (the caller passed xs = []), so its body never ran.`,
    )
  })

  test('a postcondition failure explains the lines after the call', () => {
    // Arrange
    const source = 'fn f(x) ensures result > x { x }\nprint(f(1))\nprint("after")\n'
    const recording = recorded(source)

    // Act
    const why = whyNot(recording, 3)

    // Assert
    expect(why.sentence).toBe(
      `Line 3 never ran: the run stopped at step ${recording.length}, when the postcondition \`result > x\` of f (line 1) failed, before reaching it.`,
    )
  })

  test('a clause line is found in the tree: one that never ran belongs to a function never called', () => {
    // Arrange
    const source = 'fn f(x)\n  requires x > 0\n{\n  x\n}\nprint(1)\n'

    // Act
    const why = whyNot(recorded(source), 2)

    // Assert
    expect(why).toMatchObject({ kind: 'never-called', functionName: 'f' })
  })

  test('a clause line that ran is reported as run', () => {
    // Arrange / Act
    const why = whyNot(recorded(AVERAGE), 2)

    // Assert
    expect(why).toMatchObject({ kind: 'ran', hits: 2 })
  })
})
