import { describe, expect, test } from 'vitest'
import { Op } from '../bytecode'
import { BUILTIN_NAMES, LIBRARY_NAMES, NATIVE_COUNT } from '../builtin-names'
import { InternalError } from '../diagnostics'
import { PRELUDE_SOURCE } from '../prelude'
import { compileOk, compileSource, listing } from './test-support'

describe('library mode', () => {
  test('compiles the real prelude without diagnostics', () => {
    const program = compileOk(PRELUDE_SOURCE, 'library', 0)
    expect(program.globals).toEqual([])
    expect(program.protos).toHaveLength(1 + LIBRARY_NAMES.length)
    expect(program.protos.slice(1).map((p) => p.name)).toEqual([...LIBRARY_NAMES])
    for (const proto of program.protos) {
      expect(proto.debug.library).toBe(true)
      expect(proto.debug.source).toBe('prelude')
    }
  })

  test('top-level functions are stored with DefineBuiltin in table order', () => {
    const program = compileOk(PRELUDE_SOURCE, 'library', 0)
    const code = program.script.code
    const defined: string[] = []
    for (let ip = 0; ip < code.length; ip++) {
      if (code[ip] === Op.DefineBuiltin && code[ip - 2] === Op.Closure) {
        defined.push(BUILTIN_NAMES[code[ip + 1]!]!)
      }
    }
    expect(defined).toEqual([...LIBRARY_NAMES])
  })

  test('library names resolve to GetBuiltin', () => {
    const program = compileOk(
      'fn map(xs, f) { filter(xs, f) }\nfn filter(xs, f) { xs }',
      'library',
      3,
    )
    expect(listing(program, 0)).toEqual([
      `0000  Closure 0  ; <fn map> #4  line 1`,
      `0002  DefineBuiltin ${NATIVE_COUNT}  ; map`,
      `0004  Closure 1  ; <fn filter> #5  line 2`,
      `0006  DefineBuiltin ${NATIVE_COUNT + 1}  ; filter`,
      '0008  Nil',
      '0009  Return',
    ])
    expect(listing(program, 1)[0]).toBe(`0000  GetBuiltin ${NATIVE_COUNT + 1}  ; filter  line 1`)
  })

  test('anything but top-level library function declarations is an internal error', () => {
    expect(() => compileSource('let x = 1', 'library')).toThrow(InternalError)
    expect(() => compileSource('print(1)', 'library')).toThrow(InternalError)
    expect(() => compileSource('fn helper() { 1 }', 'library')).toThrow(InternalError)
    expect(() => compileSource('fn print() { 1 }', 'library')).toThrow(InternalError)
  })

  test('nested declarations inside library functions are ordinary locals', () => {
    const program = compileOk('fn map(xs, f) { let n = 1; fn g() { n }; g() }', 'library')
    expect(program.protos[1]!.debug.locals.map((l) => l.name)).toEqual(['xs', 'f', 'n', 'g'])
  })

  test('name errors in library code are reported as diagnostics', () => {
    expect(compileSource('fn map(xs, f) { nope }', 'library').diagnostics).toEqual([
      expect.objectContaining({ code: 'E020' }),
    ])
  })
})
