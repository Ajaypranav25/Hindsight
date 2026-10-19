import { describe, expect, test } from 'vitest'
import type { FunctionProto } from './bytecode'
import { Op } from './bytecode'
import { compileOk } from './compiler/test-support'
import { disassemble } from './disasm'

describe('disassemble', () => {
  test('a program: every proto with a header, separated by blank lines', () => {
    const source = 'fn add(a, b) {\n  a + b\n}\nprint(add(1, "x"))'
    expect(disassemble(compileOk(source))).toBe(
      [
        '== <top level> #0 (script, arity 0, upvalues 0) ==',
        '0000  Closure 0  ; <fn add> #1  line 1',
        '0002  DefineGlobal 1  ; add',
        '0004  GetBuiltin 0  ; print  line 4',
        '0006  GetGlobal 1  ; add',
        '0008  Const 2  ; 1',
        '0010  Const 3  ; "x"',
        '0012  Call 2',
        '0014  Call 1',
        '0016  Pop',
        '0017  Nil',
        '0018  Return',
        '',
        '== add #1 (function, arity 2, upvalues 0) ==',
        '0000  GetLocal 1  ; a  line 2',
        '0002  GetLocal 2  ; b',
        '0004  Add',
        '0005  Return  ; line 3',
      ].join('\n'),
    )
  })

  test('a proto: itself and nested protos, without line numbers', () => {
    const program = compileOk('{ var n = -0; let f = || { n = 1; |[x]| x + n } }')
    expect(disassemble(program.protos[1]!)).toBe(
      [
        '== f #1 (function, arity 0, upvalues 1) ==',
        '0000  Const 0  ; 1',
        '0002  SetUpvalue 0  ; n',
        '0004  Closure 1 (upvalue 0)  ; <fn> #2',
        '0008  Return',
        '',
        '== <fn> #2 (function, arity 1, upvalues 1) ==',
        '0000  GetLocal 1  ; $arg0',
        '0002  Destructure 0  ; [x]',
        '0004  Declare 1  ; x',
        '0006  GetLocal 2  ; x',
        '0008  GetUpvalue 0  ; n',
        '0009  Add',
        '0010  Return',
      ]
        .join('\n')
        .replace('0009  Add', '0010  Add')
        .replace('0010  Return', '0011  Return'),
    )
  })

  test('library programs are marked and jumps show their targets', () => {
    const program = compileOk('fn each(xs, f) { for x in xs { f(x) } }', 'library')
    const text = disassemble(program)
    expect(text).toContain('== each #1 (function, arity 2, upvalues 0, library) ==')
    expect(text).toContain('IterNext 18  ; -> 0018')
    expect(text).toContain('Closure 0  ; <fn each> #1  line 1')
  })

  test('match patterns and locals', () => {
    const text = disassemble(compileOk('let v = match 1 { [a] => a, _ => 0 }'))
    expect(text).toContain('MatchPattern 1 13  ; [a] -> 0013')
    expect(text).toContain('0007  GetLocal 2  ; a')
  })

  test('malformed code does not throw', () => {
    const base = compileOk('1').script
    const proto: FunctionProto = { ...base, code: [99, Op.Closure, 0, Op.Const, 7] }
    expect(disassemble(proto).split('\n').slice(1)).toEqual([
      '0000  ??? 99',
      '0001  Closure 0  ; 1',
      '0003  Const 7  ; ?',
    ])
  })
})
