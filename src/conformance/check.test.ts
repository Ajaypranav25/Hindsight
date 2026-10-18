import { describe, expect, test, vi } from 'vitest'
import type {
  CompileResult,
  Outcome,
  OutputEvent,
  RecordOptions,
  RunOptions,
  RunResult,
  RuntimeErrorInfo,
} from '../core/api-types'
import type { DebugInfo, FunctionProto, Program } from '../core/bytecode'
import type { CompileErrorCode, Diagnostic, RuntimeErrorCode } from '../core/diagnostics'
import {
  CONFORMANCE_MAX_STEPS,
  CONFORMANCE_SEED,
  checkSource,
  outputLines,
  type ConformanceApi,
  type RecordingSummary,
} from './check'

// ---------------------------------------------------------------------------------------------
// Fakes

function fakeProgram(source: string): Program {
  const debug: DebugInfo = {
    source: 'main',
    library: false,
    span: { start: 0, end: source.length },
    spanStart: new Int32Array(0),
    spanEnd: new Int32Array(0),
    stmtStart: new Uint8Array(0),
    stmtSpanStart: new Int32Array(0),
    stmtSpanEnd: new Int32Array(0),
    locals: [],
    upvalueNames: [],
  }
  const script: FunctionProto = {
    tag: 'proto',
    id: 0,
    name: '<top level>',
    kind: 'script',
    arity: 0,
    code: [],
    constants: [],
    upvalueCount: 0,
    debug,
  }
  return { source, script, protos: [script], firstProtoId: 0, globals: [], diagnostics: [] }
}

function diagnostic(
  code: CompileErrorCode,
  message: string,
  start: number,
  hint?: string,
): Diagnostic {
  const base = { code, severity: 'error' as const, message, span: { start, end: start + 1 } }
  return hint === undefined ? base : { ...base, hint }
}

function runtimeError(
  code: RuntimeErrorCode,
  message: string,
  start: number,
  hint?: string,
): RuntimeErrorInfo {
  const base = {
    code,
    message,
    span: { start, end: start + 1 },
    stack: [{ name: '<top level>', span: { start, end: start + 1 }, library: false }],
    time: 5,
  }
  return hint === undefined ? base : { ...base, hint }
}

function events(...texts: string[]): OutputEvent[] {
  return texts.map((text, time) => ({ time, text }))
}

function finished(outputs: OutputEvent[] = []): RunResult {
  return { outputs, outcome: { kind: 'finished' }, steps: 10 }
}

function failed(error: RuntimeErrorInfo, outputs: OutputEvent[] = []): RunResult {
  return { outputs, outcome: { kind: 'error', error }, steps: error.time }
}

interface FakeOptions {
  readonly compile?: (source: string) => CompileResult
  readonly run?: RunResult | (() => RunResult)
  readonly record?: RecordingSummary | (() => RecordingSummary)
}

/** An API that compiles everything successfully and replays the given run for `record`. */
function fakeApi(options: FakeOptions = {}): ConformanceApi & {
  readonly runCalls: RunOptions[]
  readonly recordCalls: RecordOptions[]
} {
  const runCalls: RunOptions[] = []
  const recordCalls: RecordOptions[] = []
  const runResult = (): RunResult =>
    typeof options.run === 'function' ? options.run() : (options.run ?? finished())
  return {
    runCalls,
    recordCalls,
    compile:
      options.compile ??
      ((source) => ({ ok: true, program: fakeProgram(source), diagnostics: [] })),
    run: (_program, runOptions) => {
      runCalls.push(runOptions)
      return runResult()
    },
    record: (_program, recordOptions) => {
      recordCalls.push(recordOptions)
      if (typeof options.record === 'function') return options.record()
      if (options.record !== undefined) return options.record
      const replay = runResult()
      return { length: replay.steps, outcome: replay.outcome, outputs: replay.outputs }
    },
  }
}

function compileFailure(...diagnostics: Diagnostic[]): (source: string) => CompileResult {
  return () => ({ ok: false, diagnostics })
}

// ---------------------------------------------------------------------------------------------

describe('outputLines', () => {
  test('no output events means no lines', () => {
    expect(outputLines([])).toEqual([])
  })

  test('an event with empty text is one empty line', () => {
    expect(outputLines(events(''))).toEqual([''])
  })

  test('joins events with newlines, splits them again and trims line ends', () => {
    expect(outputLines(events('a\nb  ', 'c\t', '\nd'))).toEqual(['a', 'b', 'c', '', 'd'])
  })

  test('keeps leading whitespace', () => {
    expect(outputLines(events('  x'))).toEqual(['  x'])
  })
})

describe('checkSource: annotations', () => {
  test('a malformed annotation fails the file without compiling it', () => {
    // Arrange
    const compile = vi.fn()
    const api = { ...fakeApi(), compile }

    // Act
    const result = checkSource('print(1) // expect:1', api)

    // Assert
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual(["line 1: malformed annotation '// expect:1'"])
    expect(compile).not.toHaveBeenCalled()
  })

  test('compile-error annotations cannot be mixed with output annotations', () => {
    // Arrange
    const source = 'x // expect compile error E020\nprint(1) // expect: 1'

    // Act
    const result = checkSource(source, fakeApi())

    // Assert
    expect(result.failures).toEqual([
      'a file with compile-error annotations cannot contain other annotations (line 2)',
    ])
  })

  test('compile-error annotations cannot be mixed with runtime-error annotations', () => {
    // Arrange
    const source = 'x // expect compile error\ny // expect runtime error'

    // Act
    const result = checkSource(source, fakeApi())

    // Assert
    expect(result.ok).toBe(false)
  })

  test('at most one runtime-error annotation', () => {
    // Arrange
    const source = 'a // expect runtime error R001\nb // expect runtime error R002'

    // Act
    const result = checkSource(source, fakeApi())

    // Assert
    expect(result.failures).toEqual([
      'at most one runtime-error annotation is allowed (lines 1, 2)',
    ])
  })
})

describe('checkSource: output', () => {
  test('passes when the printed lines equal the expected lines', () => {
    // Arrange
    const source = 'print(1) // expect: 1\nprint("a\\nb") // expect: a\n// expect: b'
    const api = fakeApi({ run: finished(events('1', 'a\nb')) })

    // Act
    const result = checkSource(source, api)

    // Assert
    expect(result).toEqual({ ok: true, failures: [] })
  })

  test('runs and records with the conformance step limit and seed', () => {
    // Arrange
    const api = fakeApi()

    // Act
    checkSource('let x = 1', api)

    // Assert
    expect(CONFORMANCE_MAX_STEPS).toBe(5_000_000)
    expect(CONFORMANCE_SEED).toBe(42)
    expect(api.runCalls).toEqual([{ maxSteps: 5_000_000, seed: 42 }])
    expect(api.recordCalls).toEqual([{ maxSteps: 5_000_000, seed: 42 }])
  })

  test('a bare expect matches an empty printed line', () => {
    expect(checkSource('print("") // expect:', fakeApi({ run: finished(events('')) })).ok).toBe(
      true,
    )
  })

  test('a program that prints nothing passes without output annotations', () => {
    expect(checkSource('let x = 1', fakeApi()).ok).toBe(true)
  })

  test('reports the first differing line', () => {
    // Arrange
    const source = 'print(1) // expect: 1\nprint(2) // expect: 2'
    const api = fakeApi({ run: finished(events('1', '3')) })

    // Act
    const result = checkSource(source, api)

    // Assert
    expect(result.failures).toEqual([
      'output differs at output line 2 (expected 2 lines, got 2):\n' +
        '  expected: "2"\n  actual:   "3"',
    ])
  })

  test('reports missing lines', () => {
    // Arrange
    const api = fakeApi({ run: finished(events('1')) })

    // Act
    const result = checkSource('// expect: 1\n// expect: 2', api)

    // Assert
    expect(result.failures[0]).toContain('expected: "2"\n  actual:   (no line)')
  })

  test('reports extra lines', () => {
    // Arrange
    const api = fakeApi({ run: finished(events('1', 'extra')) })

    // Act
    const result = checkSource('// expect: 1', api)

    // Assert
    expect(result.failures[0]).toContain('expected: (no line)\n  actual:   "extra"')
  })

  test('collects expected lines from every annotation in file order', () => {
    // Arrange
    const source = 'f() // expect: x // expect: y\ng()\n// expect: z'
    const api = fakeApi({ run: finished(events('x\ny', 'z')) })

    // Act / Assert
    expect(checkSource(source, api).ok).toBe(true)
  })

  test('fails when the program does not compile', () => {
    // Arrange
    const api = fakeApi({
      compile: compileFailure(diagnostic('E020', "undefined variable 'x'", 6, 'did you mean y?')),
    })

    // Act
    const result = checkSource('print(x)', api)

    // Assert
    expect(result.failures).toEqual([
      'expected the program to compile, but compilation failed:\n' +
        "  line 1: E020 undefined variable 'x' (hint: did you mean y?)",
    ])
  })

  test('fails when the program hits the step limit', () => {
    // Arrange
    const outcome: Outcome = { kind: 'step-limit', maxSteps: 5_000_000 }
    const api = fakeApi({ run: { outputs: [], outcome, steps: 5_000_000 } })

    // Act
    const result = checkSource('while true {}', api)

    // Assert
    expect(result.failures).toEqual(['the program did not finish within 5000000 steps'])
  })

  test('fails when the run is aborted', () => {
    // Arrange
    const api = fakeApi({ run: { outputs: [], outcome: { kind: 'aborted' }, steps: 3 } })

    // Act / Assert
    expect(checkSource('x', api).failures).toEqual(['the run was aborted'])
  })

  test('fails on an unexpected runtime error', () => {
    // Arrange
    const api = fakeApi({ run: failed(runtimeError('R002', 'division by zero', 9)) })

    // Act
    const result = checkSource('let a = 1\nprint(1 / 0)', api)

    // Assert
    expect(result.failures).toEqual(['unexpected runtime error: line 1: R002 division by zero'])
  })
})

describe('checkSource: compile errors', () => {
  const source = [
    'let a = 1',
    'print(prnt) // expect compile error E020: undefined variable // hint: did you mean',
    'x = 2 // expect compile error',
  ].join('\n')
  const prnt = diagnostic('E020', "undefined variable 'prnt'", 16, "did you mean 'print'?")
  const assignment = diagnostic('E020', "undefined variable 'x'", source.indexOf('x = 2'))

  test('passes when diagnostics and annotations match in both directions', () => {
    expect(checkSource(source, fakeApi({ compile: compileFailure(prnt, assignment) }))).toEqual({
      ok: true,
      failures: [],
    })
  })

  test('does not run the program', () => {
    // Arrange
    const api = fakeApi({ compile: compileFailure(prnt, assignment) })

    // Act
    checkSource(source, api)

    // Assert
    expect(api.runCalls).toEqual([])
  })

  test('fails when compilation succeeds', () => {
    expect(checkSource(source, fakeApi()).failures).toEqual([
      'expected compilation to fail, but it succeeded',
    ])
  })

  test('fails for a diagnostic without a matching annotation', () => {
    // Arrange
    const extra = diagnostic('E022', "'a' is already declared on line 1", 4)

    // Act
    const result = checkSource(
      source,
      fakeApi({ compile: compileFailure(prnt, assignment, extra) }),
    )

    // Assert
    expect(result.failures).toEqual([
      "unexpected diagnostic: line 1: E022 'a' is already declared on line 1",
    ])
  })

  test('fails for an annotation without a matching diagnostic', () => {
    expect(checkSource(source, fakeApi({ compile: compileFailure(prnt) })).failures).toEqual([
      'no diagnostic matches the annotation: line 3: compile error',
    ])
  })

  test('a diagnostic on another line does not match', () => {
    // Arrange
    const misplaced = diagnostic('E020', "undefined variable 'prnt'", 2, "did you mean 'print'?")

    // Act
    const result = checkSource(source, fakeApi({ compile: compileFailure(misplaced, assignment) }))

    // Assert
    expect(result.failures).toEqual([
      "unexpected diagnostic: line 1: E020 undefined variable 'prnt' (hint: did you mean 'print'?)",
      'no diagnostic matches the annotation: line 2: compile error E020: undefined variable ' +
        '// hint: did you mean',
    ])
  })

  test.each([
    ['a different code', diagnostic('E021', "undefined variable 'prnt'", 16, 'did you mean')],
    ['a message without the text', diagnostic('E020', 'unknown name', 16, 'did you mean')],
    ['a hint without the text', diagnostic('E020', "undefined variable 'prnt'", 16, 'no idea')],
    ['no hint at all', diagnostic('E020', "undefined variable 'prnt'", 16)],
  ])('a diagnostic with %s does not match', (_label, wrong) => {
    expect(checkSource(source, fakeApi({ compile: compileFailure(wrong, assignment) })).ok).toBe(
      false,
    )
  })

  test('one annotation may cover several diagnostics on its line', () => {
    // Arrange
    const twoOnOneLine = 'a < b < c < d // expect compile error E013'
    const first = diagnostic('E013', 'comparison operators cannot be chained', 6)
    const second = diagnostic('E013', 'comparison operators cannot be chained', 10)

    // Act / Assert
    expect(checkSource(twoOnOneLine, fakeApi({ compile: compileFailure(first, second) })).ok).toBe(
      true,
    )
  })

  test('uses the line of the span start', () => {
    // Arrange
    const crlf = 'let a = 1\r\nlet b = (\r\n// expect compile error E011'
    const atEnd = diagnostic('E011', 'expected an expression but found end of file', crlf.length)

    // Act / Assert
    expect(checkSource(crlf, fakeApi({ compile: compileFailure(atEnd) })).ok).toBe(true)
  })
})

describe('checkSource: runtime errors', () => {
  const source = [
    'print("before") // expect: before',
    'let n = "a"',
    "print(n + 1) // expect runtime error R001: cannot apply '+' // hint: convert with str()",
  ].join('\n')
  const errorStart = source.indexOf('n + 1')
  const r001 = runtimeError(
    'R001',
    "cannot apply '+' to string and number",
    errorStart,
    'convert with str() or use interpolation, e.g. "{x}"',
  )

  test('passes when the output and the error match', () => {
    expect(checkSource(source, fakeApi({ run: failed(r001, events('before')) }))).toEqual({
      ok: true,
      failures: [],
    })
  })

  test('cross-checks the recording of a failing program too', () => {
    // Arrange
    const api = fakeApi({ run: failed(r001, events('before')) })

    // Act
    checkSource(source, api)

    // Assert
    expect(api.recordCalls).toHaveLength(1)
  })

  test('fails when the program finishes', () => {
    // Arrange
    const api = fakeApi({ run: finished(events('before')) })

    // Act
    const result = checkSource(source, api)

    // Assert
    expect(result.failures).toEqual([
      "the program finished without a runtime error (expected line 3: runtime error R001: cannot apply '+' // hint: convert with str())",
    ])
  })

  test.each([
    ['another line', runtimeError('R001', "cannot apply '+'", 0, 'convert with str()')],
    ['another code', runtimeError('R002', "cannot apply '+'", errorStart, 'convert with str()')],
    ['another message', runtimeError('R001', 'division by zero', errorStart, 'convert with str()')],
    ['no hint', runtimeError('R001', "cannot apply '+' to string", errorStart)],
  ])('fails for an error on %s', (_label, error) => {
    // Arrange
    const api = fakeApi({ run: failed(error, events('before')) })

    // Act
    const result = checkSource(source, api)

    // Assert
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatch(/^the runtime error does not match the annotation:\n/)
  })

  test('reports an output mismatch and an error mismatch together', () => {
    // Arrange
    const wrong = runtimeError('R002', 'division by zero', errorStart)
    const api = fakeApi({ run: failed(wrong, events('after')) })

    // Act
    const result = checkSource(source, api)

    // Assert
    expect(result.failures).toHaveLength(2)
    expect(api.recordCalls).toEqual([])
  })

  test('an annotation without code or text matches any error on its line', () => {
    // Arrange
    const bare = 'print(1) // expect: 1\nboom() // expect runtime error'
    const error = runtimeError('R006', "'boom' was used before it was defined", 22)

    // Act / Assert
    expect(checkSource(bare, fakeApi({ run: failed(error, events('1')) })).ok).toBe(true)
  })
})

describe('checkSource: recording cross-check', () => {
  const source = 'print(1) // expect: 1'
  const run = finished(events('1'))

  test('fails when the recording printed something else', () => {
    // Arrange
    const api = fakeApi({ run, record: { length: 10, outcome: run.outcome, outputs: events('2') } })

    // Act
    const result = checkSource(source, api)

    // Assert
    expect(result.failures).toEqual([
      'recording outputs differ: event 1: run "1" at time 0, recording "2" at time 0',
    ])
  })

  test('fails when an output happened at another time', () => {
    // Arrange
    const outputs = [{ time: 4, text: '1' }]
    const api = fakeApi({ run, record: { length: 10, outcome: run.outcome, outputs } })

    // Act
    const result = checkSource(source, api)

    // Assert
    expect(result.failures).toEqual([
      'recording outputs differ: event 1: run "1" at time 0, recording "1" at time 4',
    ])
  })

  test('fails when the recording printed a different number of times', () => {
    // Arrange
    const api = fakeApi({ run, record: { length: 10, outcome: run.outcome, outputs: [] } })

    // Act / Assert
    expect(checkSource(source, api).failures).toEqual([
      'recording outputs differ: the run printed 1 times, the recording 0 times',
    ])
  })

  test('fails when the recording has another length', () => {
    // Arrange
    const api = fakeApi({ run, record: { length: 11, outcome: run.outcome, outputs: run.outputs } })

    // Act / Assert
    expect(checkSource(source, api).failures).toEqual([
      'the recording has 11 steps but the run took 10',
    ])
  })

  test('fails when the recording ends differently', () => {
    // Arrange
    const outcome: Outcome = { kind: 'step-limit', maxSteps: 10 }
    const api = fakeApi({ run, record: { length: 10, outcome, outputs: run.outputs } })

    // Act / Assert
    expect(checkSource(source, api).failures).toEqual([
      'recording outcome differs: run finished, recording step-limit',
    ])
  })

  test('fails when the recorded error differs', () => {
    // Arrange
    const errorSource = 'x() // expect runtime error R004'
    const error = runtimeError('R004', 'cannot call a number', 0)
    const moved = { ...error, span: { start: 0, end: 3 } }
    const api = fakeApi({
      run: failed(error),
      record: { length: error.time, outcome: { kind: 'error', error: moved }, outputs: [] },
    })

    // Act
    const result = checkSource(errorSource, api)

    // Assert
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatch(/^recording outcome differs: run error \{.*"span":\[0,1\]/)
  })

  test('accepts identical recorded errors', () => {
    // Arrange
    const errorSource = 'x() // expect runtime error R004'
    const error = runtimeError('R004', 'cannot call a number', 0, 'some hint')
    const api = fakeApi({
      run: failed(error),
      record: { length: error.time, outcome: { kind: 'error', error: { ...error } }, outputs: [] },
    })

    // Act / Assert
    expect(checkSource(errorSource, api).ok).toBe(true)
  })
})

describe('checkSource: exceptions', () => {
  test('a throwing compile fails the file', () => {
    // Arrange
    const api = {
      ...fakeApi(),
      compile: (): CompileResult => {
        throw new RangeError('Maximum call stack size exceeded')
      },
    }

    // Act
    const result = checkSource('print(1)', api)

    // Assert
    expect(result.failures).toEqual([
      'compile threw an exception: RangeError: Maximum call stack size exceeded',
    ])
  })

  test('a throwing run fails the file', () => {
    // Arrange
    const api = fakeApi({
      run: () => {
        throw new Error('boom')
      },
    })

    // Act / Assert
    expect(checkSource('print(1)', api).failures).toEqual(['run threw an exception: Error: boom'])
  })

  test('a throwing record fails the file', () => {
    // Arrange
    const api = fakeApi({
      record: () => {
        throw 'not an error object'
      },
    })

    // Act / Assert
    expect(checkSource('print(1)', api).failures).toEqual([
      'record threw an exception: not an error object',
    ])
  })
})
