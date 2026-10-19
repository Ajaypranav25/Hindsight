/**
 * End-to-end smoke tests through the public API (src/core/index.ts, ARCHITECTURE §8).
 */
import { describe, expect, test } from 'vitest'
import {
  type CompileResult,
  type Program,
  type Recording,
  DEFAULT_MAX_STEPS,
  InternalError,
  LineIndex,
  compile,
  disassemble,
  getLibrarySource,
  lex,
  parse,
  record,
  recordAsync,
  repr,
  run,
  show,
  verifyProgram,
} from '../src/core/index'
import { LIBRARY_NAMES, NATIVE_COUNT } from '../src/core/builtin-names'
import { buildLibrary, getLibrary } from '../src/core/library'
import { PRELUDE_SOURCE } from '../src/core/prelude'

function compiled(source: string): Program {
  const result: CompileResult = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return result.program
}

function printed(source: string): string[] {
  return run(compiled(source)).outputs.map((event) => event.text)
}

function lineOf(source: string, offset: number): number {
  return new LineIndex(source).lineOf(offset)
}

describe('the library', () => {
  test('is built once and shared', () => {
    expect(getLibrary()).toBe(getLibrary())
  })

  test('holds the natives followed by the library closures with builtin ids', () => {
    // Arrange
    const library = getLibrary()

    // Act
    const closures = library.builtins.slice(NATIVE_COUNT)

    // Assert
    expect(closures).toHaveLength(LIBRARY_NAMES.length)
    closures.forEach((value, i) => {
      expect(value).toMatchObject({ type: 'closure', id: -(NATIVE_COUNT + i + 1) })
    })
    expect(library.protos.every((proto, id) => proto.id === id && proto.debug.library)).toBe(true)
  })

  test('exposes the prelude source', () => {
    expect(getLibrarySource()).toBe(PRELUDE_SOURCE)
  })

  test('a prelude that does not parse is an internal error', () => {
    expect(() => buildLibrary('fn map(')).toThrow(InternalError)
  })

  test('a prelude with name errors is an internal error carrying the diagnostics', () => {
    expect(() => buildLibrary('fn map(xs, f) { nope }')).toThrow(/E020/)
  })

  test('a prelude that leaves a library function undefined is an internal error', () => {
    expect(() => buildLibrary('fn map(xs, f) { xs }')).toThrow(/did not define 'filter'/)
  })
})

describe('compile', () => {
  test('hello world compiles and runs', () => {
    // Arrange
    const result = compile('print("hello, world")')

    // Act / Assert
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
    expect(printed('print("hello, world")')).toEqual(['hello, world'])
  })

  test('reports only the lexer stage when the lexer fails', () => {
    // Arrange: a lexical error plus a name error
    const result = compile('let a = 1 # oops\nprint(b)')

    // Assert
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toEqual(['E001'])
  })

  test('reports every name-stage error, sorted', () => {
    // Act
    const result = compile('print(zz)\nlet q = 1\nq = 2\nprint(yy)')

    // Assert
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toEqual(['E020', 'E021', 'E020'])
    const starts = result.diagnostics.map((d) => d.span.start)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })

  test('a syntax error stops at the first one', () => {
    const result = compile('print(1 +)\nprint(2 +)')
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]!.code).toBe('E011')
  })

  test('never throws on deeply nested input', () => {
    const source = `${'['.repeat(5000)}${']'.repeat(5000)}`
    const result = compile(source)
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]!.code).toBe('E028')
  })

  test('lex and parse are exposed for editors', () => {
    expect(lex('let x = 1 // c').comments).toHaveLength(1)
    expect(parse('let x = 1').diagnostics).toEqual([])
  })

  test('disassemble and verifyProgram work on compiled programs', () => {
    const program = compiled('fn f(x) { x + 1 }\nprint(f(2))')
    expect(disassemble(program)).toContain('Call')
    expect(verifyProgram(program)).toEqual([])
  })
})

describe('run', () => {
  test('library functions work', () => {
    // Arrange
    const source = [
      'let xs = [5, 3, 8, 1]',
      'print(map(xs, |x| x * 2))',
      'print(filter(xs, |x| x > 2))',
      'print(sort_by(xs, |x| x))',
      'print(group_by(xs, |x| if x % 2 == 0 { "even" } else { "odd" }))',
    ].join('\n')

    // Act / Assert
    expect(printed(source)).toEqual([
      '[10, 6, 16, 2]',
      '[5, 3, 8]',
      '[1, 3, 5, 8]',
      '{odd: [5, 3, 1], even: [8]}',
    ])
  })

  test('an error inside library code is reported at the user call', () => {
    // Arrange: map calls its callback, which is a number
    const source = 'let xs = [1, 2]\nlet ys = map(xs, 5)\nprint(ys)'

    // Act
    const result = run(compiled(source))

    // Assert
    if (result.outcome.kind !== 'error') throw new Error(`unexpected ${result.outcome.kind}`)
    const error = result.outcome.error
    expect(error.code).toBe('R004')
    expect(error.message).toBe('cannot call a number')
    expect(source.slice(error.span.start, error.span.end)).toBe('map(xs, 5)')
    expect(error.stack.map((entry) => entry.name)).toEqual(['map', '<top level>'])
    expect(error.stack[0]!.library).toBe(true)
    expect(error.time).toBe(result.steps)
  })

  test('an error in a callback is reported in the callback', () => {
    const source = 'let xs = [1, 2]\nlet ys = map(xs, |x| x + "a")'
    const result = run(compiled(source))
    if (result.outcome.kind !== 'error') throw new Error('expected an error')
    expect(result.outcome.error.code).toBe('R001')
    const { start, end } = result.outcome.error.span
    expect(source.slice(start, end)).toBe('x + "a"')
  })

  test('a runtime error in a multi-line pipeline is on the failing stage line', () => {
    // Arrange
    const source = [
      'let xs = [1, 2, 3]',
      'let r = xs',
      '  |> map(|x| x * 2)',
      '  |> filter(5)',
      '  |> len()',
    ].join('\n')

    // Act
    const result = run(compiled(source))

    // Assert
    if (result.outcome.kind !== 'error') throw new Error('expected an error')
    const { span } = result.outcome.error
    expect(lineOf(source, span.start)).toBe(4)
    expect(source.slice(span.start, span.end)).toBe('|> filter(5)')
  })

  test('stops at the step limit and reports it', () => {
    const result = run(compiled('var i = 0\nwhile true { i += 1 }'), { maxSteps: 100 })
    expect(result.outcome).toEqual({ kind: 'step-limit', maxSteps: 100 })
    expect(result.steps).toBe(100)
  })

  test('streams output through onOutput and honors the seed', () => {
    const texts: string[] = []
    const program = compiled('print(random())\nprint(random_int(1, 6))')
    const result = run(program, { seed: 7, onOutput: (text) => texts.push(text) })
    expect(texts).toEqual(result.outputs.map((event) => event.text))
    expect(run(program, { seed: 7 }).outputs).toEqual(result.outputs)
    expect(run(program).outputs).toEqual(run(program, { seed: 42 }).outputs)
  })

  test('rejects an invalid step limit', () => {
    expect(() => run(compiled('1'), { maxSteps: -1 })).toThrow(InternalError)
    expect(DEFAULT_MAX_STEPS).toBe(2_000_000)
  })

  test('show and repr follow SPEC §4.3', () => {
    expect(show('a"b')).toBe('a"b')
    expect(repr('a"b')).toBe('"a\\"b"')
    expect(show(null)).toBe('nil')
  })
})

const NAV_SOURCE = [
  'fn sq(n) {',
  '  n * n',
  '}',
  'var total = 0',
  'for i in 1..=3 {',
  '  total += sq(i)',
  '}',
  'print(total)',
].join('\n')

describe('record', () => {
  test('agrees with run and supports navigation, origin and history', () => {
    // Arrange
    const program = compiled(NAV_SOURCE)
    const fast = run(program)

    // Act
    const recording = record(program)

    // Assert: same run
    expect(recording.outcome).toEqual({ kind: 'finished' })
    expect(recording.length).toBe(fast.steps)
    expect(recording.outputs).toEqual(fast.outputs)
    expect(recording.outputs.map((o) => o.text)).toEqual(['14'])

    // Breakpoints and line hits
    expect(recording.lineHits(6)).toHaveLength(3)
    const hit = recording.continue(0, 'forward', new Set([6]))
    expect(recording.locationAt(hit)!.stmtLine).toBe(6)
    expect(recording.lineHitCounts().get(6)).toBe(3)

    // Step into enters sq; step over stays at top level; step out returns
    const inside = recording.step(hit, 'into', 'forward')
    expect(recording.locationAt(inside)!.functionName).toBe('sq')
    expect(recording.depthAt(inside)).toBe(1)
    const over = recording.step(hit, 'over', 'forward')
    expect(recording.depthAt(over)).toBe(0)
    expect(recording.step(inside, 'out', 'forward')).toBeGreaterThan(inside)
    expect(recording.step(hit, 'into', 'backward')).toBeLessThan(hit)

    // State, origin and history of `total`
    const end = recording.stateAt(recording.length)
    expect(end.frames).toEqual([])
    const total = end.globals.find((g) => g.name === 'total')!
    expect(total.value).toEqual({ kind: 'number', value: 14 })
    const target = { kind: 'global', name: 'total' } as const
    const origin = recording.origin(target, recording.length)!
    expect(origin.kind).toBe('write')
    expect(origin.value).toBe(14)
    expect(recording.locationAt(origin.time)!.stmtLine).toBe(6)
    const history = recording.history(target, recording.length)
    expect(history.events.map((e) => e.value)).toEqual([0, 1, 5, 14])
    expect(history.events[0]!.kind).toBe('declare')
    expect(history.truncated).toBe(false)
  })

  test('shows local variables inside a call', () => {
    const recording = record(compiled(NAV_SOURCE))
    const hit = recording.continue(0, 'forward', new Set([2]))
    const state = recording.stateAt(hit)
    const frame = state.frames.at(-1)!
    expect(frame.name).toBe('sq')
    expect(frame.locals.map((local) => [local.name, local.value])).toEqual([
      ['n', { kind: 'number', value: 1 }],
    ])
    const origin = recording.origin(frame.locals[0]!.target, hit)!
    expect(origin.kind).toBe('declare')
  })

  test('just-my-code step over from a callback lands on its next invocation', () => {
    const source = 'let ys = map([1, 2], |x| {\n  x + 1\n})\nprint(ys)'
    const recording = record(compiled(source))
    const first = recording.continue(0, 'forward', new Set([2]))
    const next = recording.step(first, 'over', 'forward', { justMyCode: true })
    const location = recording.locationAt(next)!
    expect(location.library).toBe(false)
    expect(location.stmtLine).toBe(2)
    expect(next).toBeGreaterThan(first)
  })

  test('a runtime error recording ends at the failing step', () => {
    const program = compiled('let xs = [1]\nprint("a")\nprint(xs[3])')
    const recording = record(program)
    expect(recording.outcome.kind).toBe('error')
    expect(recording.length).toBe(run(program).steps)
    expect(recording.stateAt(recording.length).error!.code).toBe('R007')
    expect(recording.locationAt(recording.length)!.line).toBe(3)
  })

  test('extend continues a step-limited recording', () => {
    // Arrange
    const program = compiled(NAV_SOURCE)
    const full = record(program)
    const limited = record(program, { maxSteps: 20 })

    // Act
    const extended = limited.extend(1_000)

    // Assert
    expect(limited.outcome).toEqual({ kind: 'step-limit', maxSteps: 20 })
    expect(limited.length).toBe(20)
    expect(extended.outcome).toEqual({ kind: 'finished' })
    expect(extended.length).toBe(full.length)
    expect(extended.outputs).toEqual(full.outputs)
    expect(extended.stateAt(10)).toEqual(full.stateAt(10))
    expect(extended.stateAt(full.length - 1)).toEqual(full.stateAt(full.length - 1))
    expect(limited.length).toBe(20)
    expect(() => full.extend(10)).toThrow(InternalError)
  })

  test('recordAsync produces the same recording and can be aborted', async () => {
    const program = compiled(NAV_SOURCE)
    const sync = record(program)
    const progress: number[] = []
    const asyncRecording: Recording = await recordAsync(program, {
      onProgress: (time) => progress.push(time),
    })
    expect(asyncRecording.length).toBe(sync.length)
    expect(asyncRecording.outputs).toEqual(sync.outputs)

    const aborted = await recordAsync(compiled('while true { }'), { signal: { aborted: true } })
    expect(aborted.outcome.kind).toBe('aborted')
  })
})
