import { describe, expect, test } from 'vitest'
import { Op, isFunctionProto, isPatternConst } from '../bytecode'
import { builtinIndex } from '../builtin-names'
import { assemble, bindCount } from './assembler'
import { tokenizeLine } from './assembler-tokens'

describe('assembler', () => {
  test('instructions, constants, names and builtins', () => {
    const program = assemble(`
Const 1.5      ; a number
Const "a b"
Const 1.5
Const -0
Const NaN
Const NaN
GetGlobal x
SetField "y z"
GetBuiltin print
DefineBuiltin 60
Const #0
PopN 3`)
    const { code, constants } = program.script
    expect(constants.slice(0, 3)).toEqual([1.5, 'a b', -0])
    expect(Object.is(constants[2], -0)).toBe(true)
    expect(code.slice(0, 8)).toEqual([Op.Const, 0, Op.Const, 1, Op.Const, 0, Op.Const, 2])
    expect(constants[3]).toBeNaN()
    expect(code.slice(-8)).toEqual([
      Op.GetBuiltin,
      builtinIndex('print'),
      Op.DefineBuiltin,
      60,
      Op.Const,
      0,
      Op.PopN,
      3,
    ])
    expect(constants).toContain('x')
    expect(constants).toContain('y z')
  })

  test('labels resolve to absolute code indices, forwards and backwards', () => {
    const { code } = assemble('@top: Nil\nJumpIfFalse @end\nJump @top\n@end:\nIterNext 7').script
    expect(code).toEqual([Op.Nil, Op.JumpIfFalse, 5, Op.Jump, 0, Op.IterNext, 7])
  })

  test('functions get ids in order, display names, arity, upvalues and library flags', () => {
    const program = assemble(
      `Closure outer\nReturn\n.fn outer arity=2 upvalues=0\nClosure inner local 1, upvalue 0\nReturn\n.fn inner anon upvalues=2 library\nNil\nReturn\n.end\n.end`,
      { firstProtoId: 5, source: 'src' },
    )
    expect(program.source).toBe('src')
    expect(program.protos.map((p) => [p.id, p.name, p.arity, p.upvalueCount])).toEqual([
      [5, '<top level>', 0, 0],
      [6, 'outer', 2, 0],
      [7, null, 0, 2],
    ])
    expect(program.script.kind).toBe('script')
    const outer = program.protos[1]!
    expect(outer.code).toEqual([Op.Closure, 0, 1, 1, 0, 0, Op.Return])
    expect(outer.constants[0]).toBe(program.protos[2])
    expect(program.protos[2]!.debug).toMatchObject({ library: true, source: 'prelude' })
    expect(isFunctionProto(program.script.constants[0])).toBe(true)
  })

  test('patterns are JSON with a computed bindCount', () => {
    const program = assemble(
      'Destructure {"desc":{"t":"list","before":[{"t":"bind"}],"rest":"bind","after":[]},"text":"[a, ...r]"}\nMatchPattern {"t":"bind"} @x\n@x:',
    )
    const [first, second] = program.script.constants
    expect(isPatternConst(first) && first).toMatchObject({ text: '[a, ...r]', bindCount: 2 })
    expect(isPatternConst(second) && second).toMatchObject({ text: '<pattern>', bindCount: 1 })
    expect(program.script.code).toEqual([Op.Destructure, 0, Op.MatchPattern, 1, 5])
  })

  test('debug directives fill spans, statement starts and locals', () => {
    const program = assemble(`
.global g var
.global h fn
.fnspan 0 50
.span 1 2
.stmt 0 10
.start
Const 1
.span 3 4
Declare 1
@after: Nil
.local x slot=1 start=@after end=5 kind=var mutable decl=0:3
.local $t slot=2 end=@after hidden
.upname up
Return`)
    const debug = program.script.debug
    expect(Array.from(debug.spanStart)).toEqual([1, 1, 3, 3, 3, 3])
    expect(Array.from(debug.spanEnd)).toEqual([2, 2, 4, 4, 4, 4])
    expect(Array.from(debug.stmtStart)).toEqual([1, 0, 0, 0, 0, 0])
    expect(Array.from(debug.stmtSpanEnd)).toEqual([10, 10, 10, 10, 10, 10])
    expect(debug.span).toEqual({ start: 0, end: 50 })
    expect(debug.upvalueNames).toEqual(['up'])
    expect(debug.locals).toEqual([
      {
        name: 'x',
        slot: 1,
        startIp: 4,
        endIp: 5,
        mutable: true,
        hidden: false,
        kind: 'var',
        declSpan: { start: 0, end: 3 },
      },
      {
        name: '$t',
        slot: 2,
        startIp: 0,
        endIp: 4,
        mutable: false,
        hidden: true,
        kind: 'let',
        declSpan: { start: 0, end: 0 },
      },
    ])
    expect(program.globals).toEqual([
      { name: 'g', kind: 'var', mutable: true, declSpan: { start: 0, end: 0 } },
      { name: 'h', kind: 'fn', mutable: false, declSpan: { start: 0, end: 0 } },
    ])
  })

  test.each([
    ['Bogus 1', /unknown instruction Bogus/],
    ['Jump @nowhere', /unknown label @nowhere/],
    ['@a:\n@a:', /duplicate label @a/],
    ['.fn f\nNil', /missing \.end/],
    ['.end', /\.end without \.fn/],
    ['Const abc', /bad constant abc/],
    ['Const', /Const takes 1 operand\(s\), got 0/],
    ['Nil 1', /Nil takes 0 operand/],
    ['GetBuiltin nope', /unknown builtin nope/],
    ['Closure ghost', /unknown function ghost/],
    ['Closure', /expected a function name/],
    ['.fn f\n.end\n.fn f\n.end', /duplicate function f/],
    ['Closure f elsewhere 1\n.fn f\n.end', /expected local or upvalue/],
    ['Destructure {"t":}', /bad pattern JSON/],
    ['.fn f\n.global x let\n.end', /\.global inside \.fn/],
    ['.global x const', /bad global kind const/],
    ['.span a 1', /expected an integer/],
    ['.local x end=1', /needs slot=N/],
    ['.local x slot=1', /needs end=/],
    ['.local x slot=1 end=@missing', /unknown label @missing/],
    ['.nope', /unknown directive \.nope/],
    ['Const "abc', /unterminated string/],
    ['Destructure {"t":"any"', /unbalanced brackets/],
    ['PopN x', /expected an integer, got 'x'/],
  ])('rejects %j', (text, message) => {
    expect(() => assemble(text)).toThrow(message)
  })

  test('the tokenizer keeps strings and JSON whole and drops comments', () => {
    expect(tokenizeLine('Const "a ; b" ; comment', 1)).toEqual(['Const', '"a ; b"'])
    expect(tokenizeLine('X {"a": [1, "}"]} @l, y', 1)).toEqual(['X', '{"a": [1, "}"]}', '@l', 'y'])
    expect(tokenizeLine('Const "q\\"x"', 1)).toEqual(['Const', '"q\\"x"'])
  })

  test('bindCount counts binds and bound rests but not alternatives', () => {
    expect(
      bindCount({
        t: 'record',
        fields: [
          { key: 'a', pattern: { t: 'bind' } },
          {
            key: 'b',
            pattern: { t: 'list', before: [{ t: 'bind' }], rest: 'bind', after: [{ t: 'any' }] },
          },
          { key: 'c', pattern: { t: 'or', alternatives: [{ t: 'lit', value: 1 }] } },
          { key: 'd', pattern: { t: 'range', start: 0, end: 1, inclusive: false } },
        ],
      }),
    ).toBe(3)
  })
})
