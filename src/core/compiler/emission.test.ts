import { describe, expect, test } from 'vitest'
import { codeOf } from './test-support'

// One small program per row of the emission table (ARCHITECTURE §4.3.3). codeOf also verifies.
describe('emission recipes', () => {
  test('program (main): statements, Nil, Return', () => {
    expect(codeOf('1')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Pop',
      '0003  Nil',
      '0004  Return',
    ])
  })

  test('statement-level if: expr; Pop', () => {
    expect(codeOf('if true { 1 }')).toEqual([
      '0000  True  ; line 1',
      '0001  JumpIfFalse 7  ; -> 0007',
      '0003  Const 0  ; 1',
      '0005  Jump 8  ; -> 0008',
      '0007  Nil',
      '0008  Pop',
      '0009  Nil',
      '0010  Return',
    ])
  })

  test('statement-level match: expr; Pop', () => {
    expect(codeOf('match 1 { _ => 2 }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  MatchPattern 1 9  ; _ -> 0009',
      '0005  Const 2  ; 2',
      '0007  Jump 10  ; -> 0010',
      '0009  NoMatch',
      '0010  EndScope 1',
      '0012  Pop',
      '0013  Nil',
      '0014  Return',
    ])
  })

  test('local let: e; Declare 1', () => {
    expect(codeOf('{ let x = 1 }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Declare 1  ; x',
      '0004  PopN 1',
      '0006  Nil',
      '0007  Return',
    ])
  })

  test('local destructuring let: e; Destructure k; Declare m', () => {
    expect(codeOf('fn c() { nil }\n{ var [a, {b}] = c() }')).toEqual([
      '0000  Closure 0  ; <fn c> #1  line 1',
      '0002  DefineGlobal 1  ; c',
      '0004  GetGlobal 1  ; c  line 2',
      '0006  Call 0',
      '0008  Destructure 2  ; [a, {b}]',
      '0010  Declare 2  ; a, b',
      '0012  PopN 2',
      '0014  Nil',
      '0015  Return',
    ])
  })

  test('destructuring that binds nothing omits Declare', () => {
    expect(codeOf('{ let [_, 1] = [2, 1] }')).toEqual([
      '0000  Const 0  ; 2  line 1',
      '0002  Const 1  ; 1',
      '0004  List 2',
      '0006  Destructure 2  ; [_, 1]',
      '0008  Nil',
      '0009  Return',
    ])
  })

  test('let _: e; Pop', () => {
    expect(codeOf('let _ = 1')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Pop',
      '0003  Nil',
      '0004  Return',
    ])
  })

  test('global let and var: e; DefineGlobal', () => {
    expect(codeOf('let x = 1\nvar y = x')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  DefineGlobal 1  ; x',
      '0004  GetGlobal 1  ; x  line 2',
      '0006  DefineGlobal 2  ; y',
      '0008  Nil',
      '0009  Return',
    ])
  })

  test('global destructuring defines in reverse order', () => {
    expect(codeOf('let [a, ...b] = [1, 2]')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Const 1  ; 2',
      '0004  List 2',
      '0006  Destructure 2  ; [a, ...b]',
      '0008  DefineGlobal 3  ; b',
      '0010  DefineGlobal 4  ; a',
      '0012  Nil',
      '0013  Return',
    ])
  })

  test('local fn captures its own slot', () => {
    expect(codeOf('{ fn f(n) { f(n) } }')).toEqual([
      '0000  Closure 0 (local 1)  ; <fn f> #1  line 1',
      '0004  Declare 1  ; f',
      '0006  PopN 1',
      '0008  Nil',
      '0009  Return',
    ])
  })

  test('global fn: Closure; DefineGlobal', () => {
    expect(codeOf('fn f() { 1 }')).toEqual([
      '0000  Closure 0  ; <fn f> #1  line 1',
      '0002  DefineGlobal 1  ; f',
      '0004  Nil',
      '0005  Return',
    ])
  })

  test('local assignment and compound assignment', () => {
    expect(codeOf('{ var x = 1; x = 2; x += 3 }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Declare 1  ; x',
      '0004  Const 1  ; 2',
      '0006  SetLocal 1  ; x',
      '0008  GetLocal 1  ; x',
      '0010  Const 2  ; 3',
      '0012  Add',
      '0013  SetLocal 1  ; x',
      '0015  PopN 1',
      '0017  Nil',
      '0018  Return',
    ])
  })

  test('upvalue assignment and compound assignment', () => {
    expect(codeOf('{ var x = 1; let f = || { x = 2; x -= 1 } }', 1)).toEqual([
      '0000  Const 0  ; 2  line 1',
      '0002  SetUpvalue 0  ; x',
      '0004  GetUpvalue 0  ; x',
      '0006  Const 1  ; 1',
      '0008  Sub',
      '0009  SetUpvalue 0  ; x',
      '0011  Nil',
      '0012  Return',
    ])
  })

  test('global assignment and compound assignment', () => {
    expect(codeOf('var g = 1\ng = 2\ng *= 3')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  DefineGlobal 1  ; g',
      '0004  Const 2  ; 2  line 2',
      '0006  SetGlobal 1  ; g',
      '0008  GetGlobal 1  ; g  line 3',
      '0010  Const 3  ; 3',
      '0012  Mul',
      '0013  SetGlobal 1  ; g',
      '0015  Nil',
      '0016  Return',
    ])
  })

  test('field assignment and compound assignment', () => {
    expect(codeOf('let o = {f: 1}\no.f = 2\no.f /= 2')).toEqual([
      '0000  Const 0  ; "f"  line 1',
      '0002  Const 1  ; 1',
      '0004  Record 1',
      '0006  DefineGlobal 2  ; o',
      '0008  GetGlobal 2  ; o  line 2',
      '0010  Const 3  ; 2',
      '0012  SetField 0  ; f',
      '0014  GetGlobal 2  ; o  line 3',
      '0016  Dup',
      '0017  GetField 0  ; f',
      '0019  Const 3  ; 2',
      '0021  Div',
      '0022  SetField 0  ; f',
      '0024  Nil',
      '0025  Return',
    ])
  })

  test('index assignment and compound assignment', () => {
    expect(codeOf('let o = [1]\no[0] = 2\no[0] %= 2')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  List 1',
      '0004  DefineGlobal 1  ; o',
      '0006  GetGlobal 1  ; o  line 2',
      '0008  Const 2  ; 0',
      '0010  Const 3  ; 2',
      '0012  SetIndex',
      '0013  GetGlobal 1  ; o  line 3',
      '0015  Const 2  ; 0',
      '0017  Dup2',
      '0018  GetIndex',
      '0019  Const 3  ; 2',
      '0021  Mod',
      '0022  SetIndex',
      '0023  Nil',
      '0024  Return',
    ])
  })

  test('return e and bare return', () => {
    expect(codeOf('fn f(x) { if x { return x }\n return }', 1)).toEqual([
      '0000  GetLocal 1  ; x  line 1',
      '0002  JumpIfFalse 10  ; -> 0010',
      '0004  GetLocal 1  ; x',
      '0006  Return',
      '0007  Nil',
      '0008  Jump 11  ; -> 0011',
      '0010  Nil',
      '0011  Pop',
      '0012  Nil  ; line 2',
      '0013  Return',
      '0014  Nil',
      '0015  Return',
    ])
  })

  test('break and continue pop to the loop body depth', () => {
    expect(codeOf('while true { let a = 1; { let b = 2; if a { break }; continue } }')).toEqual([
      '0000  True  ; line 1',
      '0001  JumpIfFalse 34  ; -> 0034',
      '0003  Const 0  ; 1',
      '0005  Declare 1  ; a',
      '0007  Const 1  ; 2',
      '0009  Declare 1  ; b',
      '0011  GetLocal 1  ; a',
      '0013  JumpIfFalse 22  ; -> 0022',
      '0015  PopN 2',
      '0017  Jump 34  ; -> 0034',
      '0019  Nil',
      '0020  Jump 23  ; -> 0023',
      '0022  Nil',
      '0023  Pop',
      '0024  PopN 2',
      '0026  Jump 0  ; -> 0000',
      '0028  PopN 1',
      '0030  PopN 1',
      '0032  Jump 0  ; -> 0000',
      '0034  Nil',
      '0035  Return',
    ])
  })

  test('while loop', () => {
    expect(codeOf('var i = 0\nwhile i < 3 { i += 1 }')).toEqual([
      '0000  Const 0  ; 0  line 1',
      '0002  DefineGlobal 1  ; i',
      '0004  GetGlobal 1  ; i  line 2',
      '0006  Const 2  ; 3',
      '0008  Lt',
      '0009  JumpIfFalse 20  ; -> 0020',
      '0011  GetGlobal 1  ; i',
      '0013  Const 3  ; 1',
      '0015  Add',
      '0016  SetGlobal 1  ; i',
      '0018  Jump 4  ; -> 0004',
      '0020  Nil',
      '0021  Return',
    ])
  })

  test('for loop with a body scope and an iteration scope', () => {
    expect(codeOf('for x in [1] { let y = x }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  List 1',
      '0004  IterInit',
      '0005  IterNext 19  ; -> 0019',
      '0007  Declare 1  ; x',
      '0009  GetLocal 2  ; x',
      '0011  Declare 1  ; y',
      '0013  PopN 1',
      '0015  PopN 1',
      '0017  Jump 5  ; -> 0005',
      '0019  Pop',
      '0020  Nil',
      '0021  Return',
    ])
  })

  test('for loop over _ pops the element', () => {
    expect(codeOf('for _ in 0..2 { }')).toEqual([
      '0000  Const 0  ; 0  line 1',
      '0002  Const 1  ; 2',
      '0004  Range 0  ; ..',
      '0006  IterInit',
      '0007  IterNext 12  ; -> 0012',
      '0009  Pop',
      '0010  Jump 7  ; -> 0007',
      '0012  Pop',
      '0013  Nil',
      '0014  Return',
    ])
  })

  test('for loop with a destructuring pattern', () => {
    expect(codeOf('for [a, b] in [] { a }')).toEqual([
      '0000  List 0  ; line 1',
      '0002  IterInit',
      '0003  IterNext 16  ; -> 0016',
      '0005  Destructure 0  ; [a, b]',
      '0007  Declare 2  ; a, b',
      '0009  GetLocal 2  ; a',
      '0011  Pop',
      '0012  PopN 2',
      '0014  Jump 3  ; -> 0003',
      '0016  Pop',
      '0017  Nil',
      '0018  Return',
    ])
  })

  test('break inside a for iterable targets the enclosing loop', () => {
    expect(codeOf('while true { for x in (if true { break } else { [] }) { } }')).toEqual([
      '0000  True  ; line 1',
      '0001  JumpIfFalse 25  ; -> 0025',
      '0003  True',
      '0004  JumpIfFalse 11  ; -> 0011',
      '0006  Jump 25  ; -> 0025',
      '0008  Nil',
      '0009  Jump 13  ; -> 0013',
      '0011  List 0',
      '0013  IterInit',
      '0014  IterNext 22  ; -> 0022',
      '0016  Declare 1  ; x',
      '0018  PopN 1',
      '0020  Jump 14  ; -> 0014',
      '0022  Pop',
      '0023  Jump 0  ; -> 0000',
      '0025  Nil',
      '0026  Return',
    ])
  })

  test('value-mode block keeps temporaries below its locals', () => {
    expect(codeOf('let v = 1 + if true { let z = 2; z } else { 0 }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  True',
      '0003  JumpIfFalse 15  ; -> 0015',
      '0005  Const 1  ; 2',
      '0007  Declare 1  ; z',
      '0009  GetLocal 2  ; z',
      '0011  EndScope 1',
      '0013  Jump 17  ; -> 0017',
      '0015  Const 2  ; 0',
      '0017  Add',
      '0018  DefineGlobal 3  ; v',
      '0020  Nil',
      '0021  Return',
    ])
  })

  test('else-if chains and a missing else', () => {
    expect(codeOf('let v = if false { 1 } else if true { 2 }')).toEqual([
      '0000  False  ; line 1',
      '0001  JumpIfFalse 7  ; -> 0007',
      '0003  Const 0  ; 1',
      '0005  Jump 15  ; -> 0015',
      '0007  True',
      '0008  JumpIfFalse 14  ; -> 0014',
      '0010  Const 1  ; 2',
      '0012  Jump 15  ; -> 0015',
      '0014  Nil',
      '0015  DefineGlobal 2  ; v',
      '0017  Nil',
      '0018  Return',
    ])
  })

  test('and / or', () => {
    expect(codeOf('let v = true and false or nil')).toEqual([
      '0000  True  ; line 1',
      '0001  AndJump 4  ; -> 0004',
      '0003  False',
      '0004  OrJump 7  ; -> 0007',
      '0006  Nil',
      '0007  DefineGlobal 0  ; v',
      '0009  Nil',
      '0010  Return',
    ])
  })

  test('match with a guard, a destructuring arm and a wildcard', () => {
    expect(codeOf('let v = match 1 { x if x > 0 => x, [a, b] => a, _ => 0 }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  MatchPattern 1 22  ; x -> 0022',
      '0005  Declare 1  ; x',
      '0007  GetLocal 2  ; x',
      '0009  Const 2  ; 0',
      '0011  Gt',
      '0012  JumpIfFalse 20  ; -> 0020',
      '0014  GetLocal 2  ; x',
      '0016  EndScope 1',
      '0018  Jump 41  ; -> 0041',
      '0020  PopN 1',
      '0022  MatchPattern 3 33  ; [a, b] -> 0033',
      '0025  Declare 2  ; a, b',
      '0027  GetLocal 2  ; a',
      '0029  EndScope 2',
      '0031  Jump 41  ; -> 0041',
      '0033  MatchPattern 4 40  ; _ -> 0040',
      '0036  Const 2  ; 0',
      '0038  Jump 41  ; -> 0041',
      '0040  NoMatch',
      '0041  EndScope 1',
      '0043  DefineGlobal 5  ; v',
      '0045  Nil',
      '0046  Return',
    ])
  })

  test('match with zero arms', () => {
    expect(codeOf('let v = match 1 { }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  NoMatch',
      '0003  EndScope 1',
      '0005  DefineGlobal 1  ; v',
      '0007  Nil',
      '0008  Return',
    ])
  })

  test('match arm with a block body', () => {
    expect(codeOf('let v = match [1] { [a] => { let b = a; b } }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  List 1',
      '0004  MatchPattern 1 21  ; [a] -> 0021',
      '0007  Declare 1  ; a',
      '0009  GetLocal 2  ; a',
      '0011  Declare 1  ; b',
      '0013  GetLocal 3  ; b',
      '0015  EndScope 1',
      '0017  EndScope 1',
      '0019  Jump 22  ; -> 0022',
      '0021  NoMatch',
      '0022  EndScope 1',
      '0024  DefineGlobal 2  ; v',
      '0026  Nil',
      '0027  Return',
    ])
  })

  test('literals', () => {
    expect(codeOf('let v = [1, "s", true, false, nil, -0]')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Const 1  ; "s"',
      '0004  True',
      '0005  False',
      '0006  Nil',
      '0007  Const 2  ; 0',
      '0009  Neg',
      '0010  List 6',
      '0012  DefineGlobal 3  ; v',
      '0014  Nil',
      '0015  Return',
    ])
  })

  test('template literal skips empty parts', () => {
    expect(codeOf('let n = 1\nlet v = "a{n}b{n}{n}"')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  DefineGlobal 1  ; n',
      '0004  Const 2  ; "a"  line 2',
      '0006  GetGlobal 1  ; n',
      '0008  Const 3  ; "b"',
      '0010  GetGlobal 1  ; n',
      '0012  GetGlobal 1  ; n',
      '0014  Interp 5',
      '0016  DefineGlobal 4  ; v',
      '0018  Nil',
      '0019  Return',
    ])
  })

  test('list literal with a spread', () => {
    expect(codeOf('let v = [1, ...[2], 3]')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  List 1',
      '0004  Const 1  ; 2',
      '0006  List 1',
      '0008  ListExtend',
      '0009  Const 2  ; 3',
      '0011  ListAppend',
      '0012  DefineGlobal 3  ; v',
      '0014  Nil',
      '0015  Return',
    ])
  })

  test('record literal with a spread and shorthand', () => {
    expect(codeOf('let k = {a: 1}\nlet v = {x: 1, "y z": 2, ...k, w: 3, k}')).toEqual([
      '0000  Const 0  ; "a"  line 1',
      '0002  Const 1  ; 1',
      '0004  Record 1',
      '0006  DefineGlobal 2  ; k',
      '0008  Const 3  ; "x"  line 2',
      '0010  Const 1  ; 1',
      '0012  Const 4  ; "y z"',
      '0014  Const 5  ; 2',
      '0016  Record 2',
      '0018  GetGlobal 2  ; k',
      '0020  RecordMerge',
      '0021  Const 6  ; "w"',
      '0023  Const 7  ; 3',
      '0025  RecordSet',
      '0026  Const 2  ; "k"',
      '0028  GetGlobal 2  ; k',
      '0030  RecordSet',
      '0031  DefineGlobal 8  ; v',
      '0033  Nil',
      '0034  Return',
    ])
  })

  test('unary and binary operators', () => {
    expect(
      codeOf(
        'let v = [1 + 2, 1 - 2, 1 * 2, 1 / 2, 1 % 2, 1 ** 2, 1 == 2, 1 != 2, 1 < 2, 1 <= 2, 1 > 2, 1 >= 2, 1..2, 1..=2, -1, not 1]',
      ),
    ).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Const 1  ; 2',
      '0004  Add',
      '0005  Const 0  ; 1',
      '0007  Const 1  ; 2',
      '0009  Sub',
      '0010  Const 0  ; 1',
      '0012  Const 1  ; 2',
      '0014  Mul',
      '0015  Const 0  ; 1',
      '0017  Const 1  ; 2',
      '0019  Div',
      '0020  Const 0  ; 1',
      '0022  Const 1  ; 2',
      '0024  Mod',
      '0025  Const 0  ; 1',
      '0027  Const 1  ; 2',
      '0029  Pow',
      '0030  Const 0  ; 1',
      '0032  Const 1  ; 2',
      '0034  Eq',
      '0035  Const 0  ; 1',
      '0037  Const 1  ; 2',
      '0039  Ne',
      '0040  Const 0  ; 1',
      '0042  Const 1  ; 2',
      '0044  Lt',
      '0045  Const 0  ; 1',
      '0047  Const 1  ; 2',
      '0049  Le',
      '0050  Const 0  ; 1',
      '0052  Const 1  ; 2',
      '0054  Gt',
      '0055  Const 0  ; 1',
      '0057  Const 1  ; 2',
      '0059  Ge',
      '0060  Const 0  ; 1',
      '0062  Const 1  ; 2',
      '0064  Range 0  ; ..',
      '0066  Const 0  ; 1',
      '0068  Const 1  ; 2',
      '0070  Range 1  ; ..=',
      '0072  Const 0  ; 1',
      '0074  Neg',
      '0075  Const 0  ; 1',
      '0077  Not',
      '0078  List 16',
      '0080  DefineGlobal 2  ; v',
      '0082  Nil',
      '0083  Return',
    ])
  })

  test('pipes become calls', () => {
    expect(codeOf('let v = [1] |> map(str) |> len')).toEqual([
      '0000  GetBuiltin 4  ; len  line 1',
      '0002  GetBuiltin 57  ; map',
      '0004  Const 0  ; 1',
      '0006  List 1',
      '0008  GetBuiltin 1  ; str',
      '0010  Call 2',
      '0012  Call 1',
      '0014  DefineGlobal 1  ; v',
      '0016  Nil',
      '0017  Return',
    ])
  })

  test('member and index reads', () => {
    expect(codeOf('let o = {a: [1]}\nlet v = o.a[0]')).toEqual([
      '0000  Const 0  ; "a"  line 1',
      '0002  Const 1  ; 1',
      '0004  List 1',
      '0006  Record 1',
      '0008  DefineGlobal 2  ; o',
      '0010  GetGlobal 2  ; o  line 2',
      '0012  GetField 0  ; a',
      '0014  Const 3  ; 0',
      '0016  GetIndex',
      '0017  DefineGlobal 4  ; v',
      '0019  Nil',
      '0020  Return',
    ])
  })

  test('closure capturing a local', () => {
    expect(codeOf('{ let a = 1; let f = || || a }')).toEqual([
      '0000  Const 0  ; 1  line 1',
      '0002  Declare 1  ; a',
      '0004  Closure 1 (local 1)  ; <fn f> #1',
      '0008  Declare 1  ; f',
      '0010  PopN 2',
      '0012  Nil',
      '0013  Return',
    ])
  })

  test('closure capturing an upvalue', () => {
    expect(codeOf('{ let a = 1; let f = || || a }', 1)).toEqual([
      '0000  Closure 0 (upvalue 0)  ; <fn> #2  line 1',
      '0004  Return',
    ])
  })

  test('innermost closure reads its upvalue', () => {
    expect(codeOf('{ let a = 1; let f = || || a }', 2)).toEqual([
      '0000  GetUpvalue 0  ; a  line 1',
      '0002  Return',
    ])
  })

  test('parameter prologue for pattern parameters', () => {
    expect(codeOf('fn f([a, b], _, c, {d}) { a + d }', 1)).toEqual([
      '0000  GetLocal 1  ; $arg0  line 1',
      '0002  Destructure 0  ; [a, b]',
      '0004  Declare 2  ; a, b',
      '0006  GetLocal 4  ; $arg3',
      '0008  Destructure 1  ; {d}',
      '0010  Declare 1  ; d',
      '0012  GetLocal 5  ; a',
      '0014  GetLocal 7  ; d',
      '0016  Add',
      '0017  Return',
    ])
  })

  test('lambda with an expression body', () => {
    expect(codeOf('let f = |x| x + 1', 1)).toEqual([
      '0000  GetLocal 1  ; x  line 1',
      '0002  Const 0  ; 1',
      '0004  Add',
      '0005  Return',
    ])
  })
})
