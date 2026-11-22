import { describe, expect, test } from 'vitest'
import { callTree, compile, lineMap, mapMoment, record, type Recording } from './index'

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program)
}

/** The k-th (0-based) time a statement on `line` started inside a call of `fn`. */
function nthHit(recording: Recording, line: number, k: number): number {
  return recording.lineHits(line)[k]!
}

function functionAt(recording: Recording, t: number): string {
  return callTree(recording).callAt(t, { justMyCode: true }).name
}

const PROGRAM = `fn area(w, h) {
  let a = w * h
  a
}
fn total(items) {
  var sum = 0
  for item in items {
    sum += area(item, 2)
  }
  sum
}
print(total([1, 2, 3]))
print(total([4, 5]))
`

describe('lineMap: lines of one source in another', () => {
  test('lines before and after an insertion keep their partners; new lines have none', () => {
    const map = lineMap('a\nb\nc\nd', 'a\nb\nnew\nc\nd')

    expect([1, 2, 3, 4].map(map)).toEqual([1, 2, 4, 5])
  })

  test('a changed line in the middle has no partner, its neighbours do', () => {
    const map = lineMap('a\nb\nc\nd\ne', 'a\nx\nc\ny\ne')

    expect([1, 2, 3, 4, 5].map(map)).toEqual([1, null, 3, null, 5])
  })

  test('deleted lines map to null; lines outside the source too', () => {
    const map = lineMap('a\nb\nc', 'a\nc')

    expect(map(2)).toBeNull()
    expect(map(3)).toBe(2)
    expect(map(0)).toBeNull()
    expect(map(4)).toBeNull()
    expect(map(1.5)).toBeNull()
  })
})

describe('mapMoment: the same moment of the run after an edit', () => {
  test('a step in an unchanged run maps to itself', () => {
    const a = recorded(PROGRAM)
    const b = recorded(PROGRAM)
    const t = nthHit(a, 2, 4)

    const moment = mapMoment(a, b, t)

    expect(moment).toEqual({ time: t, precision: 'line', call: 'area' })
  })

  test('after lines are inserted above, the pen stays in the same call on the same line', () => {
    const a = recorded(PROGRAM)
    const edited = PROGRAM.replace('fn total(items) {\n', 'fn total(items) {\n  let unused = 0\n')
    const b = recorded(edited)
    // The fourth call of area (the first of the second total), on `let a = w * h`.
    const t = nthHit(a, 2, 3)

    const moment = mapMoment(a, b, t)

    expect(moment.precision).toBe('line')
    expect(moment.call).toBe('area')
    expect(b.locationAt(moment.time)!.stmtLine).toBe(2)
    expect(functionAt(b, moment.time)).toBe('area')
    expect(moment.time).toBe(nthHit(b, 2, 3))
  })

  test('the n-th run of a line in the call is kept when the loop body grows', () => {
    const a = recorded(PROGRAM)
    const b = recorded(
      PROGRAM.replace('    sum += area(item, 2)\n', '    sum += area(item, 2)\n    sum += 0\n'),
    )
    // The third time `sum += area(item, 2)` ran in the first call of total.
    const t = nthHit(a, 8, 2)

    const moment = mapMoment(a, b, t)

    expect(moment.precision).toBe('line')
    expect(moment.time).toBe(nthHit(b, 8, 2))
  })

  test('a line that runs fewer times now lands on its last run in the call', () => {
    const a = recorded(PROGRAM)
    const b = recorded(PROGRAM.replace('[1, 2, 3]', '[1, 2]'))
    const t = nthHit(a, 8, 2)

    const moment = mapMoment(a, b, t)

    expect(moment.precision).toBe('nearest')
    expect(moment.time).toBe(nthHit(b, 8, 1))
  })

  test('mid-statement steps keep their offset when the statement is unchanged', () => {
    const a = recorded(PROGRAM)
    const b = recorded(`// a comment\n${PROGRAM}`)
    const t = nthHit(a, 2, 1) + 1

    const moment = mapMoment(a, b, t)

    expect(moment.time).toBe(nthHit(b, 3, 1) + 1)
  })

  test('when the line itself changed, the matching call stands in', () => {
    const a = recorded(PROGRAM)
    const b = recorded(PROGRAM.replace('let a = w * h', 'let a = w * h + 0'))
    const t = nthHit(a, 2, 1)

    const moment = mapMoment(a, b, t)

    expect(moment.precision).toBe('call')
    expect(moment.call).toBe('area')
    expect(functionAt(b, moment.time)).toBe('area')
    expect(callTree(b).call(moment.time)?.name).toBe('area')
  })

  test('a call that no longer happens maps to the step of its caller that made it', () => {
    const a = recorded(PROGRAM)
    const b = recorded(PROGRAM.replace('sum += area(item, 2)', 'sum += item * 2'))
    const t = nthHit(a, 2, 1)

    const moment = mapMoment(a, b, t)

    expect(moment.call).toBe('total')
    expect(moment.precision).toBe('beside')
    expect(b.locationAt(moment.time)!.stmtLine).toBe(8)
    expect(functionAt(b, moment.time)).toBe('total')
  })

  test('with nothing to match, the step is clamped to the new run', () => {
    const a = recorded('var x = 0\nwhile x < 50 { x += 1 }\nprint(x)\n')
    const b = recorded('print(1)\n')

    const moment = mapMoment(a, b, 100)

    expect(moment).toEqual({
      time: Math.min(100, b.length),
      precision: 'clamped',
      call: '<top level>',
    })
  })

  test('the end maps to the end, and steps outside the run are clamped first', () => {
    const a = recorded(PROGRAM)
    const b = recorded(PROGRAM.replace('[4, 5]', '[4, 5, 6]'))

    expect(mapMoment(a, b, a.length)).toMatchObject({ time: b.length, precision: 'end' })
    expect(mapMoment(a, b, 10 ** 9).time).toBe(b.length)
    expect(mapMoment(a, b, Number.NaN).time).toBe(0)
    expect(mapMoment(a, b, -5).time).toBe(0)
  })

  test('inside a library call of the pen’s call, the pen follows into the same call', () => {
    const source = 'fn show(xs) {\n  let ys = map(xs, |x| x + 1)\n  ys\n}\nprint(show([1, 2, 3]))\n'
    const a = recorded(source)
    const b = recorded(`\n${source}`)
    const tree = callTree(a)
    const mapCall = [...tree.calls()].find((call) => call.name === 'map')!
    const t = mapCall.entry + 2

    const moment = mapMoment(a, b, t)

    const mapB = [...callTree(b).calls()].find((call) => call.name === 'map')!
    expect(moment.time).toBe(mapB.entry + 2)
    expect(moment.call).toBe('show')
  })

  test('long child lists are matched by name and position', () => {
    const loop = (n: number) =>
      `fn f(i) {\n  i\n}\nvar k = 0\nwhile k < ${n} {\n  f(k)\n  k += 1\n}\n`
    const a = recorded(loop(2500))
    const b = recorded(`// edited\n${loop(2500)}`)
    const t = nthHit(a, 2, 2000)

    const moment = mapMoment(a, b, t)

    expect(moment.precision).toBe('line')
    expect(moment.time).toBe(nthHit(b, 3, 2000))
  })

  test('a long list without the call any more falls back to the step that made it', () => {
    const loop = (n: number) =>
      `fn f(i) {
  i
}
var k = 0
while k < ${n} {
  f(k)
  k += 1
}
`
    const a = recorded(loop(2500))
    const b = recorded(loop(2100))
    const t = nthHit(a, 2, 2400)

    const moment = mapMoment(a, b, t)

    expect(moment.call).toBe('<top level>')
    expect(moment.precision).toBe('nearest')
    // The call instruction of `f(k)`: as far into the statement as the pen's call was made.
    const callStep = callTree(a).callAt(t).entry - 1
    expect(moment.time).toBe(nthHit(b, 6, 2099) + callStep - nthHit(a, 6, 2400))
    expect(b.locationAt(moment.time)!.stmtLine).toBe(6)
  })

  test('a custom line map is used as given', () => {
    const a = recorded(PROGRAM)
    const b = recorded(PROGRAM)
    const t = nthHit(a, 2, 0)

    const moment = mapMoment(a, b, t, { lines: () => null })

    expect(moment.precision).toBe('call')
  })
})
