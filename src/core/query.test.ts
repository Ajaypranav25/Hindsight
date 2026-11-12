import { describe, expect, test } from 'vitest'
import { compile, record, type Recording } from './index'
import { parseQuery, queryRecording, queryTimes, type QueryResult } from './query'

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program)
}

function query(recording: Recording, text: string, limit?: number): QueryResult {
  const outcome = queryRecording(recording, text, { limit })
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome.result
}

const lineAt = (recording: Recording, t: number) => recording.locationAt(t)?.stmtLine

describe('parsing queries', () => {
  test('recognizes the three forms', () => {
    expect(parseQuery('when x > 1')).toMatchObject({ ok: true, query: { kind: 'when' } })
    expect(parseQuery('x > 1')).toMatchObject({ ok: true, query: { kind: 'when' } })
    expect(parseQuery('changed(o.paid)')).toMatchObject({ ok: true, query: { kind: 'changed' } })
    expect(parseQuery(' calls( fib ) where ret < 0 ')).toMatchObject({
      ok: true,
      query: { kind: 'calls', name: 'fib' },
    })
    expect(parseQuery('calls(fib)')).toMatchObject({ ok: true, query: { where: null } })
  })

  test('rejects what a query cannot evaluate, with a hint', () => {
    for (const text of ['', 'when', 'when x >', 'when print(x)', 'when [1, 2]', 'changed(1 + 2)']) {
      const parsed = parseQuery(text)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(10)
    }
    expect(parseQuery('when a..b')).toMatchObject({ ok: false })
    expect(parseQuery('x > 1\ny < 2')).toMatchObject({ ok: false })
  })
})

describe('when', () => {
  const LOOP = 'var xs = []\nfor i in 1..=6 {\n  push(xs, i)\n  print(i)\n}\nprint("done")\n'

  test('finds the stretch where a condition held', () => {
    const recording = recorded(LOOP)
    const result = query(recording, 'when xs.len >= 4 and i < 6')
    if (result.kind !== 'when') throw new Error('wrong kind')
    expect(result.intervals).toHaveLength(1)
    const [interval] = result.intervals
    // It begins at the statement after the fourth push and ends when i becomes 6.
    expect(lineAt(recording, interval!.from)).toBe(4)
    expect(recording.outputCountAt(interval!.from)).toBe(3)
    expect(recording.outputCountAt(interval!.to)).toBe(5)
    expect(queryTimes(result)).toEqual([interval!.from])
  })

  test('len(x) and x.len agree; unknown names never hold', () => {
    const recording = recorded(LOOP)
    const a = query(recording, 'when len(xs) == 2')
    const b = query(recording, 'xs.len == 2')
    expect(a).toEqual(b)
    expect(query(recording, 'when nothing_like_this > 1')).toMatchObject({ matches: 0 })
    expect(query(recording, 'when xs > 1')).toMatchObject({ matches: 0 })
  })

  test('depth, line and function are readable', () => {
    const recording = recorded(
      'fn inner(n) {\n  n + 1\n}\nfn outer(n) {\n  inner(n)\n}\nprint(outer(1))\n',
    )
    const deep = query(recording, 'when depth == 2')
    if (deep.kind !== 'when') throw new Error('wrong kind')
    expect(deep.intervals).toHaveLength(1)
    expect(lineAt(recording, deep.intervals[0]!.from)).toBe(2)
    expect(query(recording, 'when function == "outer" and line == 5')).toMatchObject({ matches: 1 })
    expect(query(recording, 'when n == 1 and depth > 0')).toMatchObject({ matches: 2 })
  })

  test('a condition that holds to the end closes at N; the limit truncates', () => {
    const recording = recorded(LOOP)
    const result = query(recording, 'when true')
    if (result.kind !== 'when') throw new Error('wrong kind')
    expect(result.intervals).toEqual([{ from: result.intervals[0]!.from, to: recording.length }])
    const flips = query(recording, 'when i % 2 == 0', 2)
    expect(flips).toMatchObject({ truncated: true })
    if (flips.kind === 'when') expect(flips.intervals).toHaveLength(2)
  })
})

describe('changed', () => {
  test('follows a record across functions and names', () => {
    const source =
      'fn charge(o) {\n  o.total = o.total + 5\n}\n' +
      'fn settle(bill) {\n  charge(bill)\n  bill.paid = true\n}\n' +
      'let order = {paid: false, total: 10}\nlet other = {paid: false}\n' +
      'settle(order)\nother.paid = true\n'
    const recording = recorded(source)
    const paid = query(recording, 'changed(order.paid)')
    if (paid.kind !== 'changed') throw new Error('wrong kind')
    expect(paid.events.map((event) => lineAt(recording, event.time))).toEqual([6])
    const total = query(recording, 'changed(order.total)')
    expect(queryTimes(total).map((t) => lineAt(recording, t))).toEqual([2])
    // The parameter name inside the function finds the same record.
    expect(queryTimes(query(recording, 'changed(bill.paid)'))).toEqual(queryTimes(paid))
  })

  test('a variable: its writes, and changes to the list it holds', () => {
    const recording = recorded('var n = 1\nn = 2\nlet xs = [1]\npush(xs, 2)\nxs[0] = 9\nn += 1\n')
    const n = query(recording, 'changed(n)')
    if (n.kind !== 'changed') throw new Error('wrong kind')
    expect(n.events.map((event) => [event.kind, event.value])).toEqual([
      ['declare', 1],
      ['write', 2],
      ['write', 3],
    ])
    const xs = query(recording, 'changed(xs)')
    if (xs.kind !== 'changed') throw new Error('wrong kind')
    expect(xs.events.map((event) => event.kind)).toEqual(['declare', 'list', 'write'])
    const first = query(recording, 'changed(xs[0])')
    expect(queryTimes(first).map((t) => lineAt(recording, t))).toEqual([5])
  })

  test('says so when nothing has that name', () => {
    expect(queryRecording(recorded('print(1)\n'), 'changed(ghost.x)')).toMatchObject({ ok: false })
  })
})

describe('calls', () => {
  const FIB = 'fn fib(n) { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } }\nprint(fib(6))\n'

  test('lists the calls of a function with arguments and results', () => {
    const recording = recorded(FIB)
    const all = query(recording, 'calls(fib)')
    if (all.kind !== 'calls') throw new Error('wrong kind')
    expect(all.total).toBe(25)
    expect(all.calls[0]!.text).toBe('fib(n = 6) returned 8')
    const entries = all.calls.map((call) => call.entry)
    expect(entries).toEqual([...entries].sort((a, b) => a - b))
  })

  test('filters by result and arguments', () => {
    const recording = recorded(FIB)
    const big = query(recording, 'calls(fib) where ret >= 5')
    if (big.kind !== 'calls') throw new Error('wrong kind')
    expect(big.calls.map((call) => call.text)).toEqual([
      'fib(n = 6) returned 8',
      'fib(n = 5) returned 5',
    ])
    expect(query(recording, 'calls(fib) where n == 0')).toMatchObject({ total: 5 })
    expect(query(recording, 'calls(fib) where ret < 0')).toMatchObject({ total: 0, calls: [] })
    expect(query(recording, 'calls(fib) where depth == 1')).toMatchObject({ total: 1 })
  })

  test('a call that never returned has no ret', () => {
    const recording = recorded('fn boom(n) { n / nil }\nboom(1)\n')
    const all = query(recording, 'calls(boom)')
    if (all.kind !== 'calls') throw new Error('wrong kind')
    expect(all.calls[0]!.text).toBe('boom(n = 1) did not return')
    expect(query(recording, 'calls(boom) where ret == 1')).toMatchObject({ total: 0 })
  })

  test('limits the list and reports the total; unknown functions are an error', () => {
    const recording = recorded(FIB)
    expect(query(recording, 'calls(fib)', 3)).toMatchObject({ total: 25, truncated: true })
    expect(queryRecording(recording, 'calls(nope)')).toMatchObject({ ok: false })
  })
})
