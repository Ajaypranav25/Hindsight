/**
 * Breadth tests for the laboratory modules: every operator a query can evaluate, every kind of
 * instruction the dependence graph reads, every mutation site a repair can change, and the less
 * common explanations of why a line did not run.
 */
import { describe, expect, test } from 'vitest'
import { dependenceOf } from './dependence'
import { compile, record, type Recording, repairSearch } from './index'
import { solveInverse } from './inverse'
import { queryRecording } from './query'
import { backwardSlice, errorSlice } from './slice'
import { whyNot } from './why-not'

function recorded(source: string, maxSteps?: number): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program, { maxSteps })
}

function matches(recording: Recording, text: string): number {
  const outcome = queryRecording(recording, text)
  if (!outcome.ok) throw new Error(outcome.error)
  const { result } = outcome
  return result.kind === 'when' ? result.matches : result.total
}

describe('query expressions', () => {
  const recording = recorded(
    'let n = 7\nlet s = "abc"\nlet xs = [1, 2, 3]\nlet r = {a: 1, "b c": 2}\nlet no = nil\nlet t = true\nprint(n)\n',
  )
  const holds = (text: string) => matches(recording, `when line == 7 and (${text})`) === 1

  test.each([
    'n + 1 == 8',
    'n - 1 == 6',
    'n * 2 == 14',
    'n / 2 == 3.5',
    'n % 4 == 3',
    '-n % 4 == 1',
    'n ** 2 == 49',
    '-n == 0 - 7',
    'n != 8',
    'n >= 7 and n <= 7 and n > 6 and n < 8',
    's + "d" == "abcd"',
    's < "abd" and s >= "abc"',
    'not (n == 8)',
    'n == 8 or t',
    'no == nil',
    'xs[0] == 1 and xs[-1] == 3',
    'r.a == 1 and r["b c"] == 2',
    'len(xs) == 3 and xs.len == 3 and s.length == 3 and len(r) == 2',
    'type(n) == "number" and type(xs) == "list"',
    'abs(0 - n) == 7',
    'has(r, "a") and not has(r, "z")',
    'contains(xs, 2) and not contains(xs, 9) and contains(s, "bc")',
    'function == "<top level>" and step > 0 and depth == 0',
  ])('%s holds', (text) => {
    expect(holds(text)).toBe(true)
  })

  test.each([
    'n < "a"',
    's - 1 == 0',
    'xs[9] == 1',
    'r.zzz == 1',
    'n.a == 1',
    'len(n) == 1',
    'has(n, "a")',
    'contains(n, 1)',
    'abs(s) == 1',
    'missing == 1',
    'r[0] == 1',
    'no.len == 0',
  ])('%s has no value, so it does not hold', (text) => {
    expect(holds(text)).toBe(false)
  })

  test('and / or return their operands, as the language does', () => {
    expect(holds('(no or n) == 7')).toBe(true)
    expect(holds('(n and s) == "abc"')).toBe(true)
    expect(holds('(no and n) == nil')).toBe(true)
  })

  test('names resolve to locals, captured variables, then globals', () => {
    const source =
      'let n = 1\nfn make() {\n  var kept = 5\n  fn(n) {\n    kept += n\n    kept\n  }\n}\nlet add = make()\nadd(10)\nadd(20)\n'
    const closures = recorded(source)
    expect(matches(closures, 'when kept == 15 and n == 20')).toBeGreaterThan(0)
    expect(matches(closures, 'changed(kept)')).toBe(3)
    expect(matches(closures, 'calls(lambda) where ret == 35')).toBe(1)
    expect(matches(closures, 'changed(n)')).toBeGreaterThanOrEqual(3)
  })

  test('changed follows fields, elements and string keys', () => {
    const changes = recorded(
      'let r = {a: 1}\nlet xs = [1, 2]\nr.a = 2\nr["a"] = 3\nxs[-1] = 9\npush(xs, 4)\ndelete(r, "a")\n',
    )
    expect(matches(changes, 'changed(r.a)')).toBe(3)
    expect(matches(changes, 'changed(r["a"])')).toBe(3)
    expect(matches(changes, 'changed(xs[1])')).toBe(1)
    expect(matches(changes, 'changed(xs)')).toBe(3)
    expect(queryRecording(changes, 'changed(r.a.b)').ok).toBe(false)
  })
})

/** Programs that between them execute every kind of instruction the graph reads. */
const WIDE = [
  'fn make() {\n  var n = 0\n  fn() {\n    n += 1\n    n\n  }\n}\nlet next = make()\nnext()\nprint(next())\n',
  'let r = {a: 1, ...{b: 2}}\nlet xs = [1, ...[2, 3], 4]\nlet [first, ...rest] = xs\nlet {a, b} = r\nprint("{first} {rest} {a + b}")\n',
  'let xs = [3, 1, 2]\ninsert(xs, 0, 9)\nremove(xs, 1)\npop(xs)\npush(xs, 5)\nxs[0] += 1\nvar total = 0\nfor x in xs { total += x }\nprint(total)\n',
  'let r = {k: 1}\nr.k += 2\nr["z"] = 5\nvar seen = ""\nfor key in r { seen = seen + key }\nprint(seen)\n',
  'fn kind(v) {\n  match v {\n    0 => "zero",\n    [a, b] => "pair",\n    {x} => "point",\n    n if n < 0 => "neg",\n    _ => "other",\n  }\n}\nprint(kind(0) + kind(-1) + kind([1, 2]) + kind({x: 1}) + kind(5))\n',
  'var i = 0\nvar hits = 0\nwhile true {\n  i += 1\n  if i > 5 { break }\n  if i % 2 == 0 { continue }\n  hits += 1\n}\nprint(hits)\n',
  'let a = nil\nlet b = a or 3\nlet c = b and b * 2\nlet d = not (c == 6)\nlet e = -c ** 2 % 5\nprint(d or e)\n',
  'var g = 1\nfn bump() { g = g + 1 }\nbump()\nfor i in 1..3 { bump() }\nprint(g)\n',
  'let words = map(["a", "b"], |w| upper(w))\nprint(join(words, "-") == "A-B")\n',
  'fn f([p, q], {z}) { p + q + z }\nprint(f([1, 2], {z: 3}))\n',
]

describe('dependence over many kinds of program', () => {
  test.each(WIDE.map((source, i) => [i, source] as const))(
    'program %i: edges point backwards and the output depends on something',
    (_i, source) => {
      const recording = recorded(source)
      const graph = dependenceOf(recording)!
      for (let t = 0; t <= graph.length; t++) {
        for (const dep of graph.depsOf(t)) {
          expect(dep).toBeGreaterThanOrEqual(0)
          expect(dep).toBeLessThan(t)
        }
      }
      const slice = backwardSlice(recording, recording.outputs.at(-1)!.time)!
      expect(slice.steps).toBeGreaterThan(1)
      expect(slice.lines.size).toBeGreaterThan(0)
      // A criterion outside the run is ignored, not thrown.
      expect(backwardSlice(recording, [-1, 1e9])!.steps).toBe(0)
    },
  )

  test('a slice is sound: values outside it do not move the output', () => {
    for (const source of WIDE) {
      const recording = recorded(source)
      const at = recording.outputs.at(-1)!.time
      const slice = backwardSlice(recording, at)!
      const before = recording.stateAt(at)
      for (const global of before.globals) {
        if (global.value.kind !== 'number') continue
        const origin = recording.origin(global.target, at)
        if (origin === null || slice.marks[origin.time] === 1) continue
        const fork = recording.fork(at, { target: global.target, value: global.value.value + 1 })
        if (!fork.ok) continue
        expect(fork.recording.outputs.at(-1)?.text).toBe(recording.outputs.at(-1)?.text)
      }
    }
  })

  test('runs that stop early, fail in a callback, or are empty', () => {
    const limited = recorded('var i = 0\nwhile true { i += 1 }\n', 40)
    expect(backwardSlice(limited, limited.length)!.steps).toBeGreaterThan(1)
    const failed = recorded('let xs = [1, 0]\nprint(map(xs, |x| 1 / nil))\n')
    expect([...errorSlice(failed)!.lines]).toContain(2)
    const empty = recorded('')
    expect(dependenceOf(empty)!.slice([0]).length).toBe(empty.length + 1)
  })
})

describe('repair sites', () => {
  function tried(source: string): { changes: string[]; tried: number } {
    const recording = recorded(source)
    const search = repairSearch(recording, { kind: 'crash' }, { maxMutants: 400, maxRepairs: 99 })
    let next = search.next()
    while (next.done !== true) next = search.next()
    return { changes: next.value.repairs.map((repair) => repair.change), tried: next.value.tried }
  }

  test('comparisons, logic, booleans, ranges and compound assignments are all tried', () => {
    const source =
      'fn f(xs) {\n  var t = 0\n  var ok = true\n  for i in 0..=len(xs) {\n' +
      '    if i >= 0 and ok or false { t += xs[i] }\n    t -= 0\n    t *= 1\n  }\n' +
      '  let m = match t {\n    0 => 1,\n    _ => 2,\n  }\n  let s = "{t + m}"\n  if not ok { return [t, -t] }\n  let out = {total: t, text: s}\n  out\n}\nprint(f([1, 2]))\n'
    const { changes, tried: count } = tried(source)
    expect(count).toBeGreaterThan(20)
    expect(changes).toContain('`..=` → `..`')
  })

  test('the top level is repaired without touching the functions it declares', () => {
    const source = 'fn safe(n) { n + 1 }\nlet xs = [1, 2]\nlet i = 1 + 1\nprint(xs[i])\n'
    const recording = recorded(source)
    const search = repairSearch(recording, { kind: 'crash' })
    let next = search.next()
    while (next.done !== true) next = search.next()
    expect(next.value.repairs.length).toBeGreaterThan(0)
    for (const repair of next.value.repairs) expect(repair.line).toBeGreaterThan(1)
  })
})

describe('more explanations of lines that did not run', () => {
  test('an else-if chain blames the first condition that was true', () => {
    const source =
      'let n = 5\nif n > 3 {\n  print("big")\n} else if n > 1 {\n  print("mid")\n} else {\n  print("small")\n}\n'
    const recording = recorded(source)
    expect(whyNot(recording, 5)).toMatchObject({ kind: 'guard', construct: 'else', guardLine: 2 })
    expect(whyNot(recording, 7)).toMatchObject({ kind: 'guard', guardLine: 2, value: 'true' })
  })

  test('a guarded match arm, an expression arm and a lambda body', () => {
    const source =
      'let v = 4\nlet label = match v {\n  n if n > 10 =>\n    "big",\n  _ => "small",\n}\n' +
      'let twice = |x|\n  x * 2\nprint(label)\n'
    const recording = recorded(source)
    expect(whyNot(recording, 4)).toMatchObject({ kind: 'guard', construct: 'match' })
    expect(whyNot(recording, 4).sentence).toContain('if n > 10')
    expect(whyNot(recording, 8)).toMatchObject({ kind: 'never-called' })
  })

  test('code after break and continue, inside records, lists and templates', () => {
    const source =
      'for i in [1, 2] {\n  if i > 0 { continue }\n  print({a: [i,\n    i + 1], b: "{i}"})\n}\n' +
      'while true {\n  break\n  print("never")\n}\nfn g() {\n  return nil\n  print(1)\n}\ng()\n'
    const recording = recorded(source)
    expect(whyNot(recording, 4).kind).toBe('cut-short')
    expect(whyNot(recording, 8).kind).toBe('cut-short')
    expect(whyNot(recording, 12)).toMatchObject({ kind: 'cut-short', time: null })
  })

  test('a function called only from code that did not run, two levels up', () => {
    const source =
      'fn inner() {\n  print("in")\n}\nfn outer() {\n  inner()\n}\nlet go = false\nif go {\n  outer()\n}\n'
    const why = whyNot(recorded(source), 2)
    if (why.kind !== 'never-called') throw new Error(why.sentence)
    expect(why.callSite).toMatchObject({ kind: 'never-called', functionName: 'outer' })
    expect(why.sentence).toContain('`go` was false')
  })
})

describe('more inverse searches', () => {
  test('a goal between two whole numbers is bracketed and given up on', () => {
    const recording = recorded('let n = 3\nprint(n * 2)\n')
    const result = solveInverse(recording, { kind: 'output', index: 0, text: '7' })
    expect(result.solutions.map((s) => s.value)).toEqual([])
    expect(result.forks).toBeGreaterThanOrEqual(1)
  })

  test('a fractional input is solved by bisection through a step function', () => {
    const recording = recorded('let x = 0.5\nprint(floor(x * 10))\n')
    const result = solveInverse(recording, { kind: 'output', index: 0, text: '42' })
    const [best] = result.solutions
    expect(best).toBeDefined()
    expect(Math.floor((best!.value as number) * 10)).toBe(42)
  })

  test('a text goal is probed with nearby values', () => {
    const recording = recorded('let n = 3\nprint(if n > 3 { "many" } else { "few" })\n')
    const result = solveInverse(recording, { kind: 'output', index: 0, text: 'many' })
    expect(result.solutions[0]).toMatchObject({ candidate: { name: 'n' }, value: 4 })
  })
})
