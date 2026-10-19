import { describe, expect, test } from 'vitest'
import { codeOf } from './test-support'

describe('scoping', () => {
  test('same-scope shadowing hides the earlier local from that point on', () => {
    expect(codeOf('{ let x = 1; let x = x + 1; x }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Declare 1  ; x',
      '0004  GetLocal 1  ; x',
      '0006  Const 0  ; 1',
      '0008  Add',
      '0009  Declare 1  ; x',
      '0011  GetLocal 2  ; x',
      '0013  Pop',
      '0014  PopN 2',
      '0016  Nil',
      '0017  Return',
    ])
  })

  test('let x = x reads a visible outer local', () => {
    expect(codeOf('{ let x = 1; { let x = x } }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Declare 1  ; x',
      '0004  GetLocal 1  ; x',
      '0006  Declare 1  ; x',
      '0008  PopN 1',
      '0010  PopN 1',
      '0012  Nil',
      '0013  Return',
    ])
  })

  test('let x = x without an outer local reads the global', () => {
    expect(codeOf('let x = 1\n{ let x = x }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  DefineGlobal 1  ; x',
      '0004  GetGlobal 1  ; x  line 2',
      '0006  Declare 1  ; x',
      '0008  PopN 1',
      '0010  Nil',
      '0011  Return',
    ])
  })

  test('declarations inside top-level blocks are locals', () => {
    expect(codeOf('let g = 1\n{ let g = 2; g }\ng')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  DefineGlobal 1  ; g',
      '0004  Const 2  ; 2  line 2',
      '0006  Declare 1  ; g',
      '0008  GetLocal 1  ; g',
      '0010  Pop',
      '0011  PopN 1',
      '0013  GetGlobal 1  ; g  line 3',
      '0015  Pop',
      '0016  Nil',
      '0017  Return',
    ])
  })

  test('globals referenced in functions are late-bound', () => {
    expect(codeOf('fn f() { later }\nlet later = 1', 1)).toEqual([
      '0000  GetGlobal 0  ; later  line 1',
      '0002  Return',
    ])
  })

  test('globals shadow builtins', () => {
    expect(codeOf('let len = 3\nlen')).toEqual([
      '0000  Const 0  ; 3  line 1',
      '0002  DefineGlobal 1  ; len',
      '0004  GetGlobal 1  ; len  line 2',
      '0006  Pop',
      '0007  Nil',
      '0008  Return',
    ])
  })

  test('parameters shadow globals', () => {
    expect(codeOf('let a = 1\nfn f(a) { a }', 1)).toEqual([
      '0000  GetLocal 1  ; a  line 2',
      '0002  Return',
    ])
  })

  test('each loop iteration has a fresh variable to capture', () => {
    expect(codeOf('for i in 0..3 { let f = || i }')).toEqual([
      '0000  Const 0  ; 0  line 1',
      '0002  Const 1  ; 3',
      '0004  Range 0  ; ..',
      '0006  IterInit',
      '0007  IterNext 23  ; -> 0023',
      '0009  Declare 1  ; i',
      '0011  Closure 2 (local 2)  ; <fn f> #1',
      '0015  Declare 1  ; f',
      '0017  PopN 1',
      '0019  PopN 1',
      '0021  Jump 7  ; -> 0007',
      '0023  Pop',
      '0024  Nil',
      '0025  Return',
    ])
  })

  test('upvalues are shared per variable', () => {
    expect(codeOf('{ let a = 1; let f = || { a; || a + a } }', 1)).toEqual([
      '0000  GetUpvalue 0  ; a  line 1',
      '0002  Pop',
      '0003  Closure 0 (upvalue 0)  ; <fn> #2',
      '0007  Return',
    ])
  })

  test('parameters can be captured', () => {
    expect(codeOf('fn f(x) { || x }', 1)).toEqual([
      '0000  Closure 0 (local 1)  ; <fn> #2  line 1',
      '0004  Return',
    ])
  })

  test('pattern parameter bindings can be captured', () => {
    expect(codeOf('fn f([x]) { || x }', 1)).toEqual([
      '0000  GetLocal 1  ; $arg0  line 1',
      '0002  Destructure 0  ; [x]',
      '0004  Declare 1  ; x',
      '0006  Closure 1 (local 2)  ; <fn> #2',
      '0010  Return',
    ])
  })

  test('match bindings can be captured', () => {
    expect(codeOf('let v = match 1 { y => || y }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  MatchPattern 1 15  ; y -> 0015',
      '0005  Declare 1  ; y',
      '0007  Closure 2 (local 2)  ; <fn> #1',
      '0011  EndScope 1',
      '0013  Jump 16  ; -> 0016',
      '0015  NoMatch',
      '0016  EndScope 1',
      '0018  DefineGlobal 3  ; v',
      '0020  Nil',
      '0021  Return',
    ])
  })
})
