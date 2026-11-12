import { describe, expect, test } from 'vitest'
import { compile, record, type Recording } from './index'
import { whyNot } from './why-not'

function recorded(source: string, maxSteps?: number): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program, { maxSteps })
}

describe('why a line did not run', () => {
  test('an if whose condition was false, with the operand and where it was set', () => {
    const source =
      'var total = 50\ntotal = total + 25\nif total > 80 {\n  print("free shipping")\n}\nprint(total)\n'
    const recording = recorded(source)
    const why = whyNot(recording, 4)
    if (why.kind !== 'guard') throw new Error(why.sentence)
    expect(why).toMatchObject({
      construct: 'if',
      guardLine: 3,
      condition: 'total > 80',
      value: 'false',
      checks: 1,
    })
    expect(why.operands).toEqual([
      { name: 'total', value: '75', origin: { time: recording.lineHits(3)[0]! - 1, line: 2 } },
    ])
    expect(why.sentence).toBe(
      `Line 4 never ran because at step ${why.time}, \`total > 80\` was false (total was 75, set at step ${why.operands[0]!.origin!.time} on line 2).`,
    )
    // The moment is the decision: the next instruction is the conditional jump.
    expect(recording.locationAt(why.time)?.opName).toBe('JumpIfFalse')
  })

  test('an else that never ran because the condition was always true', () => {
    const source =
      'for n in [5, 7] {\n  if n > 1 {\n    print(n)\n  } else {\n    print("small")\n  }\n}\n'
    const why = whyNot(recorded(source), 5)
    expect(why).toMatchObject({ kind: 'guard', construct: 'else', value: 'true', checks: 2 })
    expect(why.sentence).toContain('each of the 2 times it was checked')
    expect(why.sentence).toContain('n was 7')
  })

  test('the outer guard explains when the inner one was never reached', () => {
    const source =
      'let mode = "fast"\nlet level = 3\nif mode == "safe" {\n  if level > 1 {\n    print("checked")\n  }\n}\n'
    const why = whyNot(recorded(source), 5)
    expect(why).toMatchObject({ kind: 'guard', guardLine: 3, condition: 'mode == "safe"' })
  })

  test('a loop body: nothing to loop over, or a condition false from the start', () => {
    const empty = whyNot(recorded('let items = []\nfor item in items {\n  print(item)\n}\n'), 3)
    expect(empty).toMatchObject({
      kind: 'guard',
      construct: 'for',
      condition: 'items',
      value: '[]',
    })
    expect(empty.sentence).toContain('nothing to loop over')
    const never = whyNot(recorded('var n = 10\nwhile n < 5 {\n  n += 1\n}\n'), 3)
    expect(never).toMatchObject({ kind: 'guard', construct: 'while', value: 'false' })
  })

  test('a match arm that was not taken', () => {
    const source =
      'let shape = {kind: "circle"}\nmatch shape.kind {\n  "square" => print("four sides"),\n  _ => print("round"),\n}\n'
    const why = whyNot(recorded(source), 3)
    expect(why).toMatchObject({ kind: 'guard', construct: 'match', value: '"circle"' })
    expect(why.sentence).toContain('the arm `"square"` did not take')
  })

  test('a function nobody called, explained through its call site', () => {
    const source =
      'fn refund(n) {\n  print("refund")\n  n\n}\nlet paid = false\nif paid {\n  refund(5)\n}\n'
    const why = whyNot(recorded(source), 2)
    if (why.kind !== 'never-called') throw new Error(why.sentence)
    expect(why.functionName).toBe('refund')
    expect(why.callSite).toMatchObject({ kind: 'guard', condition: 'paid', guardLine: 6 })
    expect(why.sentence).toContain('Its call on line 7 did not run')
    expect(why.sentence).toContain('`paid` was false')
  })

  test('a function with no call at all', () => {
    const why = whyNot(recorded('fn unused() {\n  print("x")\n}\nprint(1)\n'), 2)
    expect(why).toMatchObject({ kind: 'never-called', callSite: null })
    expect(why.sentence).toContain('nothing in the program calls it by name')
  })

  test('code after an early return, and after a crash', () => {
    const early = whyNot(recorded('fn f(n) {\n  return n\n  print("late")\n}\nf(1)\n'), 3)
    expect(early).toMatchObject({ kind: 'cut-short', time: null })
    const crashed = recorded('let xs = [1]\nprint(xs[4])\nprint("after")\n')
    expect(whyNot(crashed, 3)).toMatchObject({ kind: 'cut-short', time: crashed.length })
    expect(whyNot(crashed, 3).sentence).toContain('error on line 2')
    const limited = recorded('var i = 0\nwhile true {\n  i += 1\n}\nprint(i)\n', 50)
    expect(whyNot(limited, 5).sentence).toContain('recording stopped')
  })

  test('lines that ran, and lines with nothing to run', () => {
    const recording = recorded('// a comment\n\nfor i in 1..=3 {\n  print(i)\n}\n')
    expect(whyNot(recording, 4)).toMatchObject({ kind: 'ran', hits: 3 })
    expect(whyNot(recording, 4).sentence).toBe('Line 4 did run (3 times).')
    for (const line of [1, 2, 5, 0, 99]) expect(whyNot(recording, line).kind).toBe('no-code')
  })

  test('a lambda that was never called', () => {
    const source = 'let twice = |n| n * 2\nlet xs = []\nprint(map(xs, |x|\n  x + 1))\n'
    expect(whyNot(recorded(source), 4)).toMatchObject({ kind: 'never-called' })
  })
})
