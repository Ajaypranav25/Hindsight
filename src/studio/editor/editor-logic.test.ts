import { describe, expect, test } from 'vitest'
import { compile, record } from '../../core/index'
import type { FrameView, Location, Recording, StateView, Token } from '../../core/index'
import { Text } from '@codemirror/state'
import { tintLineRange } from './decorations'
import { minimalChange } from './doc-sync'
import { heatLevel, heatTitle, maxHitCount, nextHit } from './gutter-math'
import { classifyToken, highlightRanges, identifierAt, tokenRanges } from './highlight'
import { computeOverlay, EMPTY_OVERLAY, MAX_HINTS, originSpanAt } from './overlay'
import { resolveName } from './resolve'

function token(kind: Token['kind'], start: number, end: number, value?: string): Token {
  return { kind, start, end, newlineBefore: false, value }
}

function classesOf(source: string): string[] {
  return highlightRanges(source).map((r) => `${r.cls}:${source.slice(r.from, r.to)}`)
}

describe('syntax classes from the lexer', () => {
  test('maps token kinds to classes', () => {
    expect(classifyToken(token('let', 0, 3))).toBe('keyword')
    expect(classifyToken(token('true', 0, 4))).toBe('atom')
    expect(classifyToken(token('Number', 0, 1))).toBe('number')
    expect(classifyToken(token('Identifier', 0, 5, 'print'))).toBe('builtin')
    expect(classifyToken(token('Identifier', 0, 3, 'foo'))).toBe('ident')
    expect(classifyToken(token('..=', 0, 3))).toBe('punct')
    expect(classifyToken(token('EOF', 0, 0))).toBeNull()
  })

  test('highlights a program with comments, builtins and interpolation', () => {
    const source = 'let x = 1 // one\nprint("a {x} b {len(xs)}")'
    expect(classesOf(source)).toEqual([
      'keyword:let',
      'ident:x',
      'punct:=',
      'number:1',
      'comment:// one',
      'builtin:print',
      'punct:(',
      'string:"a ',
      'interp:{',
      'ident:x',
      'interp:}',
      'string: b ',
      'interp:{',
      'builtin:len',
      'punct:(',
      'ident:xs',
      'punct:)',
      'interp:}',
      'string:"',
      'punct:)',
    ])
  })

  test('ranges are sorted and non-empty, also for broken input', () => {
    for (const source of ['"abc {x', '/* open', 'let 1x = "{}"', '']) {
      const ranges = highlightRanges(source)
      for (let i = 0; i < ranges.length; i++) {
        expect(ranges[i]!.to).toBeGreaterThan(ranges[i]!.from)
        if (i > 0) expect(ranges[i]!.from).toBeGreaterThanOrEqual(ranges[i - 1]!.to)
      }
    }
  })

  test('an empty string piece keeps only its braces', () => {
    expect(tokenRanges(token('StringMiddle', 4, 6))).toEqual([
      { from: 4, to: 5, cls: 'interp' },
      { from: 5, to: 6, cls: 'interp' },
    ])
  })

  test('finds the identifier under a position', () => {
    const source = 'let count = 1 // count'
    expect(identifierAt(source, 6)?.value).toBe('count')
    expect(identifierAt(source, 9)?.value).toBe('count')
    expect(identifierAt(source, 18)).toBeNull()
  })
})

describe('heat gutter math', () => {
  test('log scale with a visible minimum and a full hottest line', () => {
    expect(heatLevel(0, 100)).toBe(0)
    expect(heatLevel(100, 100)).toBe(1)
    expect(heatLevel(1, 1)).toBe(1)
    expect(heatLevel(1, 1_000_000)).toBeCloseTo(0.12)
    expect(heatLevel(1000, 1_000_000)).toBeCloseTo(Math.log1p(1000) / Math.log1p(1_000_000))
    expect(heatLevel(10, 100)).toBeGreaterThan(heatLevel(5, 100))
  })

  test('titles, maxima and next hits', () => {
    expect(heatTitle(1204)).toBe('ran 1,204 times · click to jump to the next run')
    expect(heatTitle(1)).toBe('ran once · click to jump to the next run')
    expect(
      maxHitCount(
        new Map([
          [1, 3],
          [2, 9],
        ]),
      ),
    ).toBe(9)
    expect(nextHit([4, 10, 20], 4)).toBe(10)
    expect(nextHit([4, 10, 20], 0)).toBe(4)
    expect(nextHit([4, 10, 20], 20)).toBe(4)
    expect(nextHit([], 3)).toBeNull()
  })
})

describe('document sync', () => {
  test('computes the minimal replacement', () => {
    expect(minimalChange('abc', 'abc')).toBeNull()
    expect(minimalChange('let x = 1', 'let xy = 1')).toEqual({ from: 5, to: 5, insert: 'y' })
    expect(minimalChange('aaa', 'aa')).toEqual({ from: 2, to: 3, insert: '' })
    expect(minimalChange('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' })
  })
})

const SOURCE = 'fn sq(n) {\n  let r = n * n\n  return r\n}\nlet a = sq(3)\nprint(a)\n'

function location(over: Partial<Location>): Location {
  return {
    protoId: 1,
    ip: 0,
    depth: 1,
    functionName: 'sq',
    source: 'main',
    library: false,
    span: { start: 21, end: 26 },
    stmtSpan: { start: 13, end: 26 },
    line: 2,
    stmtLine: 2,
    stmtStart: false,
    opName: 'Mul',
    ...over,
  }
}

function frame(uid: number, over: Partial<FrameView>): FrameView {
  return {
    uid,
    name: 'sq',
    protoId: 1,
    ip: 0,
    library: false,
    source: 'main',
    span: { start: 0, end: 0 },
    stmtSpan: { start: 0, end: 0 },
    line: 1,
    locals: [],
    captures: [],
    temps: [],
    ...over,
  }
}

function fixture(): StateView {
  const top = frame(1, {
    name: '<top level>',
    span: { start: 47, end: 52 },
    stmtSpan: { start: 39, end: 52 },
  })
  const inner = frame(2, {
    span: { start: 21, end: 26 },
    stmtSpan: { start: 13, end: 26 },
    locals: [
      {
        name: 'n',
        slot: 0,
        kind: 'param',
        mutable: false,
        value: { kind: 'number', value: 3 },
        declSpan: { start: 6, end: 7 },
        target: { kind: 'local', frameUid: 2, slot: 0 },
      },
      {
        name: 'r',
        slot: 1,
        kind: 'let',
        mutable: false,
        value: { kind: 'string', value: 'x'.repeat(50) },
        declSpan: { start: 17, end: 18 },
        target: { kind: 'local', frameUid: 2, slot: 1 },
      },
    ],
  })
  return {
    time: 7,
    location: location({}),
    frames: [top, inner],
    globals: [
      {
        name: 'a',
        kind: 'let',
        mutable: false,
        value: { kind: 'nil' },
        declSpan: { start: 43, end: 44 },
        target: { kind: 'global', name: 'a' },
      },
    ],
    heap: new Map(),
    heapTruncated: false,
    outputCount: 0,
    error: null,
  }
}

describe('editor overlay at the pen', () => {
  test('tints the statement, outlines the span and shows hints for the selected frame', () => {
    const overlay = computeOverlay({
      view: fixture(),
      stale: false,
      selectedFrameUid: null,
      source: SOURCE,
    })
    expect(overlay.stmtSpan).toEqual({ start: 13, end: 26 })
    expect(overlay.span).toEqual({ start: 21, end: 26 })
    expect(overlay.callerSpan).toBeNull()
    expect(overlay.hints).toEqual([
      { line: 1, text: 'n = 3' },
      { line: 2, text: `r = "${'x'.repeat(30)}…` },
    ])
  })

  test('nothing while stale or before a recording', () => {
    const input = { stale: true, selectedFrameUid: null, source: SOURCE }
    expect(computeOverlay({ ...input, view: fixture() })).toBe(EMPTY_OVERLAY)
    expect(computeOverlay({ ...input, stale: false, view: null })).toBe(EMPTY_OVERLAY)
  })

  test('a selected caller frame marks its call span instead, with globals as hints', () => {
    const overlay = computeOverlay({
      view: fixture(),
      stale: false,
      selectedFrameUid: 1,
      source: SOURCE,
    })
    expect(overlay.span).toBeNull()
    expect(overlay.callerSpan).toEqual({ start: 47, end: 52 })
    expect(overlay.stmtSpan).toEqual({ start: 39, end: 52 })
    expect(overlay.hints).toEqual([{ line: 5, text: 'a = nil' }])
  })

  test('library code shows only the library chip', () => {
    const view = { ...fixture(), location: location({ source: 'prelude', functionName: 'map' }) }
    const overlay = computeOverlay({ view, stale: false, selectedFrameUid: null, source: SOURCE })
    expect(overlay.span).toBeNull()
    expect(overlay.stmtSpan).toBeNull()
    expect(overlay.libraryFunction).toBe('map')
  })

  test('spans are clamped to the document and hints are capped', () => {
    const base = fixture()
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...base.frames[1]!.locals[0]!,
      name: `v${i}`,
      slot: i,
      declSpan: { start: i * 2, end: i * 2 + 1 },
    }))
    const source = 'x\n'.repeat(20)
    const view: StateView = {
      ...base,
      location: location({ span: { start: 30, end: 999 } }),
      frames: [base.frames[0]!, { ...base.frames[1]!, locals: many }],
    }
    const overlay = computeOverlay({ view, stale: false, selectedFrameUid: null, source })
    expect(overlay.span).toEqual({ start: 30, end: 40 })
    expect(overlay.hints).toHaveLength(MAX_HINTS)
  })
})

describe('with a real recording', () => {
  function recordSource(source: string): Recording {
    const compiled = compile(source)
    if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message)
    return record(compiled.program)
  }

  test('overlay and name resolution follow a genuine state', () => {
    const recording = recordSource(SOURCE)
    const t = recording.lineHits(3)[0]!
    const view = recording.stateAt(t)
    const overlay = computeOverlay({ view, stale: false, selectedFrameUid: null, source: SOURCE })
    expect(SOURCE.slice(overlay.stmtSpan!.start, overlay.stmtSpan!.end)).toBe('return r')
    expect(overlay.hints.map((h) => h.text)).toEqual(['n = 3', 'r = 9'])
    const inner = view.frames[view.frames.length - 1]!
    expect(resolveName('r', view, inner)?.value).toEqual({ kind: 'number', value: 9 })
    expect(resolveName('n', view, inner)?.kind).toBe('param')
    expect(resolveName('sq', view, inner)?.kind).toBe('fn')
    expect(resolveName('zzz', view, inner)).toBeNull()
    expect(recording.lineHitCounts().get(2)).toBe(1)
  })
})

describe('statement tint lines', () => {
  const source = 'for i in 0..3 {\n  print(i)\n}\nlet x = (1 +\n  2)\n'
  const doc = Text.of(source.split('\n'))
  const loop = { start: 0, end: source.indexOf('}') + 1 }

  test('a loop header tints only its own line, not the body', () => {
    const header = { start: 9, end: 13 }
    expect(tintLineRange(doc, loop, header)).toEqual({ first: 1, last: 1 })
  })

  test('tints through the line where the instruction ends, within the statement', () => {
    const stmt = { start: source.indexOf('let'), end: source.indexOf('2)') + 2 }
    const add = { start: source.indexOf('(1'), end: source.indexOf('2)') + 2 }
    expect(tintLineRange(doc, stmt, add)).toEqual({ first: 4, last: 5 })
    const pastEnd = { start: add.start, end: source.length }
    expect(tintLineRange(doc, stmt, pastEnd)).toEqual({ first: 4, last: 5 })
    const before = { start: 0, end: 3 }
    expect(tintLineRange(doc, stmt, before)).toEqual({ first: 4, last: 4 })
  })

  test('without an instruction span the whole statement is tinted', () => {
    expect(tintLineRange(doc, loop, null)).toEqual({ first: 1, last: 3 })
  })
})

describe('origin span', () => {
  test('marks the write only while the pen sits right after it, in main source', () => {
    const source = 'let a = 1\nlet b = a + 1\nprint(b)\n'
    const compiled = compile(source)
    if (!compiled.ok) throw new Error('fixture does not compile')
    const recording = record(compiled.program)
    let t = 0
    while (recording.locationAt(t)?.line !== 2) t++
    const mark = { time: t, label: 'b' }
    const span = originSpanAt(recording, mark, t + 1, source.length)
    expect(span).toEqual(recording.locationAt(t)!.span)
    expect(originSpanAt(recording, mark, t, source.length)).toBeNull()
    expect(originSpanAt(recording, null, t + 1, source.length)).toBeNull()
    expect(originSpanAt(null, mark, t + 1, source.length)).toBeNull()
  })
})
