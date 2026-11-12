/** More breadth: every place a line can sit in the syntax tree, and the rarer search outcomes. */
import { describe, expect, test } from 'vitest'
import type { CliIO } from '../cli/io'
import { main } from '../cli/main'
import { compile, record, type Recording, repairSearch, solveInverse, whyNot } from './index'

function recorded(source: string, maxSteps?: number): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program, { maxSteps })
}

/** A function nobody calls whose statements each span two lines. */
const SPRAWL = [
  'fn sprawl(a, xs, r) {',
  '  var t = a +',
  '    1',
  '  t = t *',
  '    2',
  '  xs[0] =',
  '    t',
  '  while t <',
  '    0 {',
  '    t += 1',
  '  }',
  '  for x in [a,',
  '    t] {',
  '    print(x)',
  '  }',
  '  let s = "{a}{',
  '    t}"',
  '  let l = [...xs,',
  '    -t]',
  '  let q = {...r,',
  '    k: not a}',
  '  let m = xs[',
  '    0].len',
  '  let c = if a >',
  '    1 { 1 } else { 2 }',
  '  let d = match a +',
  '    1 {',
  '    1 => 1,',
  '    _ => 2,',
  '  }',
  '  let f = fn(z) {',
  '    z',
  '  }',
  '  {',
  '    print(f(1))',
  '  }',
  '  if a > 2 {',
  '    return',
  '      a and t',
  '  }',
  '  return max(c,',
  '    d)',
  '}',
  'print(1)',
].join('\n')

describe('why-not finds a line wherever it sits', () => {
  const recording = recorded(`${SPRAWL}\n`)
  const lines = SPRAWL.split('\n')

  test.each(lines.map((text, i) => [i + 1, text] as const).slice(1, -2))(
    'line %i (%s)',
    (line, text) => {
      const why = whyNot(recording, line)
      const bare = /^[\s})\]]*,?$/.test(text)
      expect(why.kind).toBe(bare ? 'no-code' : 'never-called')
      if (why.kind === 'never-called') expect(why.functionName).toMatch(/sprawl|this function/)
    },
  )

  test('the declaration itself ran, and the last line ran', () => {
    expect(whyNot(recording, 1).kind).toBe('ran')
    expect(whyNot(recording, lines.length).kind).toBe('ran')
  })

  test('a call site inside a comment or a declaration is not a call', () => {
    const source = 'fn lonely() {\n  print(1)\n}\n// lonely() is never called\nprint(2)\n'
    expect(whyNot(recorded(source), 2).sentence).toContain('nothing in the program calls it')
  })

  test('a function whose only call site did run somewhere else', () => {
    const source = 'fn pick(f) { 1 }\nfn other() {\n  print(1)\n}\nprint(pick(other))\nlet o = 1\n'
    const why = whyNot(recorded(source), 3)
    expect(why).toMatchObject({ kind: 'never-called', callSite: null })
  })

  test('a library condition and a condition that calls a function', () => {
    const source =
      'fn small(n) { n < 3 }\nlet n = 5\nif small(n) {\n  print("small")\n}\nwhile small(n) {\n  print("loop")\n}\nprint(n)\n'
    const recording2 = recorded(source)
    expect(whyNot(recording2, 4)).toMatchObject({ kind: 'guard', value: 'false', checks: 1 })
    expect(whyNot(recording2, 4).sentence).toContain('n was 5')
    expect(whyNot(recording2, 7)).toMatchObject({ kind: 'guard', construct: 'while' })
  })
})

describe('repairs through every kind of statement', () => {
  test('a crash deep inside a sprawling function is searched without errors', () => {
    const source =
      'fn work(a, xs) {\n  var t = a + 1\n  t *= 2\n  t /= 2\n  t -= 0\n  xs[0] = t\n' +
      '  while t < 0 { t += 1 }\n  for x in 0..2 { t = t + x }\n  let s = "{a}{t}"\n' +
      '  let l = [...xs, -t]\n  let q = {k: not (a > 1 or a < 0 and true)}\n' +
      '  let c = if a >= 1 { 1 } else { 2 }\n  let d = match a {\n    1 => 1,\n    n if n != 1 => 2,\n    _ => 3,\n  }\n' +
      '  let f = |z| z % 2\n  {\n    t = t + f(1)\n  }\n  if a == 9 { return 0 }\n  return xs[t + c + d]\n}\nprint(work(1, [1, 2]))\n'
    const recording = recorded(source)
    expect(recording.outcome.kind).toBe('error')
    const search = repairSearch(recording, { kind: 'crash' }, { maxMutants: 300, maxRepairs: 50 })
    let next = search.next()
    let last = 0
    while (next.done !== true) {
      last = next.value
      next = search.next()
    }
    expect(last).toBe(next.value.tried)
    expect(next.value.tried).toBeGreaterThan(40)
    expect(next.value.problem).toBeNull()
    for (const repair of next.value.repairs) {
      expect(compile(repair.source).ok).toBe(true)
      expect(repair.before).not.toBe(repair.after)
    }
  })

  test('a mutant that loops for ever is cut off, and a crash in a callback is located', () => {
    const loop = recorded(
      'fn f(n) {\n  var i = 0\n  while i < n { i += 1 }\n  [1][i]\n}\nprint(f(3))\n',
    )
    const search = repairSearch(loop, { kind: 'crash' }, { maxMutants: 60 })
    let next = search.next()
    while (next.done !== true) next = search.next()
    expect(next.value.tried).toBeGreaterThan(5)
    const callback = recorded('print(map([1, 2], |x| [0][x]))\n')
    const found = repairSearch(callback, { kind: 'crash' })
    let step = found.next()
    while (step.done !== true) step = found.next()
    expect(step.value.problem).toBeNull()
  })
})

describe('inverse outcomes', () => {
  test('avoiding one crash can lead to another, or to the step limit', () => {
    const later = recorded('let xs = [1, 2]\nlet i = 3\nprint(xs[i])\nprint(xs[i + 5])\n')
    const result = solveInverse(later, { kind: 'no-error' })
    expect(result.solutions[0]?.sentence).toContain('it would have got further and failed with')
    const runaway = recorded('let n = 1\nvar i = 0\nwhile i != n { i += 2 }\nprint([1][n])\n', 300)
    expect(runaway.outcome.kind).toBe('step-limit')
    expect(solveInverse(runaway, { kind: 'no-error' }).problem).toContain('did not fail')
  })

  test('a line with several numbers steers the one the goal changes', () => {
    const recording = recorded('let w = 3\nlet h = 4\nprint("{w} x {h} = {w * h}")\n')
    const result = solveInverse(recording, { kind: 'output', index: 0, text: '3 x 4 = 24' })
    expect(result.solutions).toEqual([])
    const wider = solveInverse(recording, { kind: 'output', index: 0, text: '6 x 4 = 24' })
    expect(wider.solutions[0]).toMatchObject({ candidate: { name: 'w' }, value: 6 })
  })

  test('a goal of another shape, a vanished line, and a negative solution', () => {
    const recording = recorded('let n = 2\nif n > 0 { print("n is {n}") }\nprint(n - 5)\n')
    expect(solveInverse(recording, { kind: 'output', index: 0, text: 'x' }).solutions).toEqual([])
    const negative = solveInverse(recording, { kind: 'output', index: 1, text: '-9' })
    expect(negative.solutions.map((s) => s.value)).toEqual([])
    const shifted = recorded('let n = 2\nprint(n - 5)\n')
    expect(
      solveInverse(shifted, { kind: 'output', index: 0, text: '-9' }).solutions[0],
    ).toMatchObject({
      value: -4,
    })
  })
})

describe('command output for the rarer cases', () => {
  function cli(args: string[], source: string) {
    const out: string[] = []
    const err: string[] = []
    const io: CliIO = {
      color: false,
      readFile: () => source,
      listFiles: () => [],
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
    }
    return { code: main(args, io), out: out.join(''), err: err.join('') }
  }

  test('query prints list changes, deletes, object values and library lines', () => {
    const source =
      'let xs = [1]\nlet r = {a: 1, b: [2]}\npush(xs, 2)\npop(xs)\ninsert(xs, 0, "s")\nremove(xs, 0)\n' +
      'xs[0] = r.b\nr.a = nil\ndelete(r, "a")\nlet ys = sort_by([3, 1], |x| x)\nprint(1)\n'
    const lists = cli(['query', 'f', 'changed(xs)'], source).out
    expect(lists).toMatch(/append 2/)
    expect(lists).toMatch(/pop 2/)
    expect(lists).toMatch(/insert "s"/)
    expect(lists).toMatch(/<object #\d+>/)
    const fields = cli(['query', 'f', 'changed(r.a)'], source).out
    expect(fields).toContain('= nil')
    expect(fields).toContain('deleted')
    expect(cli(['query', 'f', 'when true'], source).out).toMatch(/1 stretch \(\d+ statements\)/)
    expect(cli(['query', 'f', 'calls(lambda)'], source).out).toContain('lambda(x = 3)')
  })

  test('solve reports an exhausted search and a search with nothing found', () => {
    const none = cli(['solve', 'f', '--want', '7'], 'let n = 3\nprint(n * 2)\n')
    expect(none.code).toBe(1)
    expect(none.out).toContain('No single earlier value reaches that')
    const missing = cli(['solve', 'f', '--want', '1'], 'let n = 3\n')
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('no output line')
  })

  test('whynot on a line that needs no replay hint', () => {
    expect(cli(['whynot', 'f', '--line', '2'], 'fn f() {\n  print(1)\n}\n').out).toContain(
      'never called',
    )
  })
})
