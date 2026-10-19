import { describe, expect, test } from 'vitest'
import { InternalError } from './diagnostics'
import { recordAsm, recordSource } from './testing/recording'

/**
 * Trace (t: function depth op, * marks statement starts):
 * 0* 1 top d0 (fn sq), 2* GetGlobal sq, 3 Const, 4 Call,
 * 5* sq d1, 6, 7, 8 Return, 9-11 top d0 (second call), 12* sq d1, 13, 14, 15 Return,
 * 16 Add, 17 DefineGlobal, 18* print…, 21 Pop, 22 Nil, 23 Return; N = 24.
 */
const SIBLINGS = `fn sq(x) {
  x * x
}
let a = sq(2) + sq(3)
print(a)`

/** 6* fact d1, 12* d1, 18* d2, 24* d2, 30* d3, 34* d3, 35 Return d3, 36 Mul d2, 38 Mul d1, 40 d0; N = 44. */
const FACT = `fn fact(n) {
  if n <= 1 { return 1 }
  n * fact(n - 1)
}
print(fact(3))`

/** Statements on line 3 start at 8, 16, 24; line 2 at 2, 6, 14, 22, 30; error at N = 37. */
const LOOP_ERROR = `var s = 0
for i in 0..3 {
  s += i
}
print(s)
let z = s.q`

/**
 * A library function `lib` calls the user callback `cb` twice:
 * 0* 1 top d0 | 2* 3 4 top d0 (call lib) | 5* 6 lib d1 | 7* 8 9* 10 cb d2 | 11 12* 13 lib d1 |
 * 14* 15 16* 17 cb d2 | 18 lib d1 | 19 20* 21 top d0 | N = 22. cb's statements are on lines 4, 5.
 */
const LIBRARY_CALLBACK = `
.stmt 0 1
.start
Closure lib
Declare 1
.stmt 2 3
.start
GetLocal 1
Closure cb
Call 1
Pop
.stmt 4 5
.start
Nil
Return
.fn lib arity=1 library
.start
GetLocal 1
Call 0
Pop
.start
GetLocal 1
Call 0
Return
.end
.fn cb arity=0
.stmt 6 7
.start
Const 1
Pop
.stmt 8 9
.start
Nil
Return
.end`

const LINES = 'a\nb\nc\nd\ne\nf\n'

describe('step into', () => {
  test('moves to the next and previous statement start, entering calls', () => {
    const recording = recordSource(SIBLINGS)
    expect(recording.length).toBe(24)
    expect(recording.step(2, 'into', 'forward')).toBe(5)
    expect(recording.step(5, 'into', 'forward')).toBe(12)
    expect(recording.step(12, 'into', 'backward')).toBe(5)
    expect(recording.step(18, 'into', 'forward')).toBe(24)
    expect(recording.step(24, 'into', 'backward')).toBe(18)
  })

  test('just-my-code skips library statements', () => {
    const recording = recordAsm(LIBRARY_CALLBACK, { source: LINES })
    expect(recording.step(4, 'into', 'forward')).toBe(5)
    expect(recording.step(4, 'into', 'forward', { justMyCode: true })).toBe(7)
    expect(recording.step(7, 'into', 'backward')).toBe(5)
    expect(recording.step(7, 'into', 'backward', { justMyCode: true })).toBe(2)
  })
})

describe('step over', () => {
  test('skips calls made by the current statement', () => {
    const recording = recordSource(SIBLINGS)
    expect(recording.step(2, 'over', 'forward')).toBe(18)
    expect(recording.step(18, 'over', 'backward')).toBe(2)
  })

  test('a sibling call at the same depth is a different activation (forward)', () => {
    const recording = recordSource(SIBLINGS)
    expect(recording.step(5, 'over', 'forward')).toBe(18)
  })

  test('a sibling call at the same depth is a different activation (backward)', () => {
    const recording = recordSource(SIBLINGS)
    expect(recording.step(12, 'over', 'backward')).toBe(2)
  })

  test('recursion: stays in the same activation and returns to the caller', () => {
    const recording = recordSource(FACT)
    expect(recording.length).toBe(44)
    expect(recording.step(6, 'over', 'forward')).toBe(12)
    expect(recording.step(18, 'over', 'forward')).toBe(24)
    expect(recording.step(12, 'over', 'forward')).toBe(44)
    expect(recording.step(24, 'over', 'backward')).toBe(18)
    expect(recording.step(36, 'over', 'backward')).toBe(24)
    expect(recording.step(12, 'over', 'backward')).toBe(6)
    expect(recording.step(6, 'over', 'backward')).toBe(2)
  })

  test('loops: each iteration is a separate stop', () => {
    const recording = recordSource(LOOP_ERROR)
    expect(recording.step(8, 'over', 'forward')).toBe(14)
    expect(recording.step(14, 'over', 'forward')).toBe(16)
    expect(recording.step(16, 'over', 'backward')).toBe(14)
  })

  test('just-my-code: stepping over the end of a callback lands on its next invocation', () => {
    const recording = recordAsm(LIBRARY_CALLBACK, { source: LINES })
    expect(recording.step(9, 'over', 'forward')).toBe(12)
    expect(recording.step(9, 'over', 'forward', { justMyCode: true })).toBe(14)
    expect(recording.step(14, 'over', 'backward')).toBe(12)
    expect(recording.step(14, 'over', 'backward', { justMyCode: true })).toBe(9)
    expect(recording.step(2, 'over', 'forward', { justMyCode: true })).toBe(20)
  })
})

describe('step out', () => {
  test('goes to the first step after (or the last before) the frame', () => {
    const fact = recordSource(FACT)
    expect(fact.step(30, 'out', 'forward')).toBe(36)
    expect(fact.step(30, 'out', 'backward')).toBe(29)
    expect(fact.step(2, 'out', 'forward')).toBe(44)
    expect(fact.step(2, 'out', 'backward')).toBe(0)
  })

  test('just-my-code skips library frames', () => {
    const recording = recordAsm(LIBRARY_CALLBACK, { source: LINES })
    expect(recording.step(8, 'out', 'forward')).toBe(11)
    expect(recording.step(8, 'out', 'forward', { justMyCode: true })).toBe(19)
    expect(recording.step(14, 'out', 'backward')).toBe(13)
    expect(recording.step(14, 'out', 'backward', { justMyCode: true })).toBe(4)
  })
})

describe('continue and line hits', () => {
  test('stops at user statements on breakpoint lines', () => {
    const recording = recordSource(LOOP_ERROR)
    const breakpoints = new Set([3])
    expect(recording.continue(0, 'forward', breakpoints)).toBe(8)
    expect(recording.continue(8, 'forward', breakpoints)).toBe(16)
    expect(recording.continue(24, 'forward', breakpoints)).toBe(37)
    expect(recording.continue(37, 'backward', breakpoints)).toBe(24)
    expect(recording.continue(8, 'backward', breakpoints)).toBe(0)
    expect(recording.continue(0, 'forward', new Set())).toBe(37)
  })

  test('ignores library code', () => {
    const recording = recordAsm(LIBRARY_CALLBACK, { source: LINES })
    expect(recording.continue(0, 'forward', new Set([1, 4]))).toBe(7)
    expect(recording.continue(7, 'forward', new Set([1, 4]))).toBe(14)
    expect(recording.continue(14, 'forward', new Set([1, 4]))).toBe(22)
  })

  test('line hits list user statement starts by statement line', () => {
    const recording = recordSource(LOOP_ERROR)
    expect(recording.lineHits(3)).toEqual([8, 16, 24])
    expect(recording.lineHits(2)).toEqual([2, 6, 14, 22, 30])
    expect(recording.lineHits(4)).toEqual([])
    expect(recording.lineHits(6)).toEqual([36])
    expect([...recording.lineHitCounts()]).toEqual([
      [1, 1],
      [2, 5],
      [3, 3],
      [5, 1],
      [6, 1],
    ])
  })

  test('line hits exclude library statements', () => {
    const recording = recordAsm(LIBRARY_CALLBACK, { source: LINES })
    expect([...recording.lineHitCounts()]).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
    ])
  })
})

describe('boundaries', () => {
  test('forward from N stays at N and backward from 0 stays at 0', () => {
    const recording = recordSource(SIBLINGS)
    for (const kind of ['into', 'over', 'out'] as const) {
      expect(recording.step(24, kind, 'forward')).toBe(24)
      expect(recording.step(0, kind, 'backward')).toBe(0)
    }
  })

  test('errors: N is the failing step and its depth is the failing frame', () => {
    const recording = recordSource(LOOP_ERROR)
    expect(recording.length).toBe(37)
    expect(recording.step(36, 'into', 'forward')).toBe(37)
    expect(recording.step(37, 'over', 'backward')).toBe(36)
    expect(recording.depthAt(37)).toBe(0)
  })

  test('step limit: D(N) is the depth of the paused instruction', () => {
    const recording = recordAsm(LIBRARY_CALLBACK, { source: LINES, maxSteps: 10 })
    expect(recording.outcome).toEqual({ kind: 'step-limit', maxSteps: 10 })
    expect(recording.depthAt(10)).toBe(2)
    expect(recording.step(10, 'over', 'backward')).toBe(9)
    expect(recording.step(10, 'out', 'backward')).toBe(6)
    expect(recording.step(9, 'into', 'forward')).toBe(10)
  })

  test('a finished run has depth 0 at N', () => {
    expect(recordSource(SIBLINGS).depthAt(24)).toBe(0)
  })

  test('invalid times throw InternalError', () => {
    const recording = recordSource(SIBLINGS)
    expect(() => recording.step(-1, 'into', 'forward')).toThrow(InternalError)
    expect(() => recording.step(25, 'into', 'forward')).toThrow(InternalError)
    expect(() => recording.continue(1.5, 'forward', new Set())).toThrow(InternalError)
  })
})
