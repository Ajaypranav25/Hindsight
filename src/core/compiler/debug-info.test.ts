import { describe, expect, test } from 'vitest'
import type { FunctionProto, LocalInfo } from '../bytecode'
import { instructionLength, Op } from '../bytecode'
import { compileOk, spanOf } from './test-support'

/** Instruction start indices of `op` in `proto`, in code order. */
function ipsOf(proto: FunctionProto, op: number): number[] {
  const ips: number[] = []
  for (
    let ip = 0;
    ip < proto.code.length;
    ip += instructionLength(proto.code, ip, proto.constants)
  ) {
    if (proto.code[ip] === op) ips.push(ip)
  }
  return ips
}

function spanAt(proto: FunctionProto, ip: number): { start: number; end: number } {
  return { start: proto.debug.spanStart[ip]!, end: proto.debug.spanEnd[ip]! }
}

function stmtSpanAt(proto: FunctionProto, ip: number): { start: number; end: number } {
  return { start: proto.debug.stmtSpanStart[ip]!, end: proto.debug.stmtSpanEnd[ip]! }
}

function stmtStarts(proto: FunctionProto): number[] {
  return [...proto.debug.stmtStart.keys()].filter((i) => proto.debug.stmtStart[i] === 1)
}

function visibleLocals(proto: FunctionProto): Omit<LocalInfo, 'declSpan'>[] {
  return proto.debug.locals.map(({ declSpan: _declSpan, ...rest }) => rest)
}

describe('stmtStart', () => {
  test('marks the first instruction of every statement, nothing on operands', () => {
    const program = compileOk('let a = 1\nprint(a)\n{ let b = 2 }')
    // 0 Const, 2 DefineGlobal, 4 GetBuiltin, 6 GetGlobal, 8 Call, 10 Pop, 11 Const, 13 Declare
    expect(stmtStarts(program.script)).toEqual([0, 4, 11])
  })

  test('marks IterNext, MatchPattern, arm bodies, prologues and lambda expression bodies', () => {
    const source = 'for x in [] { }\nlet v = match 1 { 1 => 2, _ => { 3 } }\nlet f = |[a]| a'
    const program = compileOk(source)
    const script = program.script
    const marked = stmtStarts(script)
    expect(marked).toEqual(expect.arrayContaining(ipsOf(script, Op.IterNext)))
    expect(marked).toEqual(expect.arrayContaining(ipsOf(script, Op.MatchPattern)))
    for (const ip of ipsOf(script, Op.MatchPattern)) {
      const bodyStart = ip + 3
      expect(script.debug.stmtStart[bodyStart]).toBe(1)
    }
    const lambda = program.protos[1]!
    // GetLocal 1 (prologue), Destructure, Declare, GetLocal 2 (body), Return
    expect(stmtStarts(lambda)).toEqual([0, 6])
  })

  test('one statement start per pattern parameter prologue', () => {
    const fn = compileOk('fn f([a], b, {c}) { a }').protos[1]!
    expect(stmtStarts(fn)).toEqual([0, 6, 12])
  })
})

describe('instruction spans (SPEC §10.4)', () => {
  test('operators cover the whole expression, operands the node', () => {
    const source = 'let v = -(1 + 2) * x\nlet x = 1'
    const script = compileOk(source.replace('* x', '* 3')).script
    const s = source.replace('* x', '* 3')
    expect(spanAt(script, ipsOf(script, Op.Add)[0]!)).toEqual(spanOf(s, '1 + 2'))
    expect(spanAt(script, ipsOf(script, Op.Neg)[0]!)).toEqual(spanOf(s, '-(1 + 2)'))
    expect(spanAt(script, ipsOf(script, Op.Mul)[0]!)).toEqual(spanOf(s, '-(1 + 2) * 3'))
    expect(spanAt(script, ipsOf(script, Op.Const)[0]!)).toEqual(spanOf(s, '1'))
  })

  test('pipe calls use the pipe span, plain calls the call', () => {
    const source = 'let v = [1] |> len\nlet w = str(1)'
    const script = compileOk(source).script
    const [pipeCall, plainCall] = ipsOf(script, Op.Call)
    expect(spanAt(script, pipeCall!)).toEqual(spanOf(source, '|> len'))
    expect(spanAt(script, plainCall!)).toEqual(spanOf(source, 'str(1)'))
  })

  test('field ops use the access span, index ops the index expression', () => {
    const source = 'var o = {a: [1]}\no.a[0] += o.a[0]\no.a = 2'
    const script = compileOk(source).script
    const getFields = ipsOf(script, Op.GetField)
    expect(spanAt(script, getFields[0]!)).toEqual(spanOf(source, '.a'))
    expect(spanAt(script, ipsOf(script, Op.SetField)[0]!)).toEqual(spanOf(source, '.a', 2))
    const getIndexes = ipsOf(script, Op.GetIndex)
    expect(spanAt(script, getIndexes[0]!)).toEqual(spanOf(source, 'o.a[0]'))
    expect(spanAt(script, getIndexes[1]!)).toEqual(spanOf(source, 'o.a[0]', 1))
    expect(spanAt(script, ipsOf(script, Op.Dup2)[0]!)).toEqual(spanOf(source, 'o.a[0]'))
    expect(spanAt(script, ipsOf(script, Op.SetIndex)[0]!)).toEqual(spanOf(source, 'o.a[0]'))
  })

  test('variable gets and sets in assignments use the target identifier', () => {
    const source = '{ var n = 1\nn += 2 }'
    const script = compileOk(source).script
    const target = spanOf(source, 'n +')
    const anchor = { start: target.start, end: target.start + 1 }
    expect(spanAt(script, ipsOf(script, Op.GetLocal)[0]!)).toEqual(anchor)
    expect(spanAt(script, ipsOf(script, Op.SetLocal)[0]!)).toEqual(anchor)
    expect(spanAt(script, ipsOf(script, Op.Add)[0]!)).toEqual(spanOf(source, 'n += 2'))
  })

  test('declarations, destructuring and globals', () => {
    const source = 'let [a] = [1]\n{ let b = 2 }'
    const script = compileOk(source).script
    expect(spanAt(script, ipsOf(script, Op.Destructure)[0]!)).toEqual(spanOf(source, '[a]'))
    expect(spanAt(script, ipsOf(script, Op.DefineGlobal)[0]!)).toEqual(
      spanOf(source, 'let [a] = [1]'),
    )
    expect(spanAt(script, ipsOf(script, Op.Declare)[0]!)).toEqual(spanOf(source, 'let b = 2'))
  })

  test('for loops use the header', () => {
    const source = 'for x in [1] { x }'
    const script = compileOk(source).script
    const header = spanOf(source, 'for x in [1]')
    for (const op of [Op.IterInit, Op.IterNext, Op.Jump, Op.Pop]) {
      const ips = ipsOf(script, op)
      expect(spanAt(script, ips[ips.length - 1]!)).toEqual(header)
    }
  })

  test('spread and item spans in list and record literals', () => {
    const source = 'let r = {a: 1}\nlet v = [0, ...[1], 2]\nlet w = {...r, b: 3}'
    const script = compileOk(source).script
    expect(spanAt(script, ipsOf(script, Op.ListExtend)[0]!)).toEqual(spanOf(source, '...[1]'))
    expect(spanAt(script, ipsOf(script, Op.ListAppend)[0]!)).toEqual(spanOf(source, '2'))
    expect(spanAt(script, ipsOf(script, Op.RecordMerge)[0]!)).toEqual(spanOf(source, '...r'))
    expect(spanAt(script, ipsOf(script, Op.RecordSet)[0]!)).toEqual(spanOf(source, 'b: 3'))
  })

  test('match: patterns, the subject and the closing brace', () => {
    const source = 'let v = match [1] { [a] => a }'
    const script = compileOk(source).script
    expect(spanAt(script, ipsOf(script, Op.MatchPattern)[0]!)).toEqual(spanOf(source, '[a]'))
    expect(spanAt(script, ipsOf(script, Op.Declare)[0]!)).toEqual(spanOf(source, '[a]'))
    expect(spanAt(script, ipsOf(script, Op.NoMatch)[0]!)).toEqual(spanOf(source, '[1]'))
    const endScopes = ipsOf(script, Op.EndScope)
    expect(spanAt(script, endScopes[endScopes.length - 1]!)).toEqual(spanOf(source, '}'))
  })

  test('block ends, implicit returns and the end of the program', () => {
    const source = 'fn f() { let a = 1; a }\nlet g = |x| x\n'
    const program = compileOk(source)
    const f = program.protos[1]!
    const brace = spanOf(source, '}')
    expect(spanAt(f, ipsOf(f, Op.EndScope)[0]!)).toEqual(brace)
    expect(spanAt(f, ipsOf(f, Op.Return)[0]!)).toEqual(brace)
    const g = program.protos[2]!
    expect(spanAt(g, ipsOf(g, Op.Return)[0]!)).toEqual(spanOf(source, 'x', 1))
    const end = { start: source.length, end: source.length }
    const script = program.script
    expect(spanAt(script, script.code.length - 1)).toEqual(end)
    expect(spanAt(script, script.code.length - 2)).toEqual(end)
  })

  test('operand indices repeat their instruction', () => {
    const script = compileOk('let v = 12').script
    expect(spanAt(script, 1)).toEqual(spanAt(script, 0))
    expect(stmtSpanAt(script, 1)).toEqual(stmtSpanAt(script, 0))
  })
})

describe('statement spans', () => {
  test('innermost statement, arms for patterns and bodies, lambda expression bodies', () => {
    const source = 'let v = match 1 { x if x > 0 => { print(x) }, _ => 0 }\nlet f = |y| y'
    const program = compileOk(source)
    const script = program.script
    const arm = spanOf(source, 'x if x > 0 => { print(x) }')
    const [first] = ipsOf(script, Op.MatchPattern)
    expect(stmtSpanAt(script, first!)).toEqual(arm)
    expect(stmtSpanAt(script, ipsOf(script, Op.GetBuiltin)[0]!)).toEqual(spanOf(source, 'print(x)'))
    expect(stmtSpanAt(script, ipsOf(script, Op.NoMatch)[0]!)).toEqual(
      spanOf(source, 'let v = match 1 { x if x > 0 => { print(x) }, _ => 0 }'),
    )
    const lambda = program.protos[1]!
    expect(stmtSpanAt(lambda, 0)).toEqual(spanOf(source, 'y', 1))
  })
})

describe('locals and live ranges', () => {
  test('block locals end after the scope-closing instruction; temporaries sit below', () => {
    const source = 'let v = 1 + if true { let z = 2; z } else { 0 }'
    const script = compileOk(source).script
    // 0 Const 1, 2 True, 3 JumpIfFalse, 5 Const 2, 7 Declare 1, 9 GetLocal 2, 11 EndScope 1
    expect(visibleLocals(script)).toEqual([
      { name: 'z', slot: 2, startIp: 9, endIp: 13, mutable: false, hidden: false, kind: 'let' },
    ])
  })

  test('parameters, hidden $argI slots and prologue bindings live to the end', () => {
    const fn = compileOk('fn f(a, [b], _) { var c = a; c }').protos[1]!
    const end = fn.code.length
    expect(visibleLocals(fn)).toEqual([
      { name: 'a', slot: 1, startIp: 0, endIp: end, mutable: false, hidden: false, kind: 'param' },
      {
        name: '$arg1',
        slot: 2,
        startIp: 0,
        endIp: end,
        mutable: false,
        hidden: true,
        kind: 'param',
      },
      {
        name: '$arg2',
        slot: 3,
        startIp: 0,
        endIp: end,
        mutable: false,
        hidden: true,
        kind: 'param',
      },
      { name: 'b', slot: 4, startIp: 6, endIp: end, mutable: false, hidden: false, kind: 'param' },
      { name: 'c', slot: 5, startIp: 10, endIp: 14, mutable: true, hidden: false, kind: 'var' },
    ])
  })

  test('for loops: $iter, loop bindings and body locals', () => {
    const source = 'for x in [1] { let y = x }'
    const script = compileOk(source).script
    // 0 Const, 2 List, 4 IterInit, 5 IterNext, 7 Declare, 9 GetLocal, 11 Declare, 13 PopN 1,
    // 15 PopN 1, 17 Jump, 19 Pop
    expect(visibleLocals(script)).toEqual([
      {
        name: '$iter',
        slot: 1,
        startIp: 5,
        endIp: 20,
        mutable: false,
        hidden: true,
        kind: 'hidden',
      },
      { name: 'x', slot: 2, startIp: 9, endIp: 17, mutable: false, hidden: false, kind: 'loop' },
      { name: 'y', slot: 3, startIp: 13, endIp: 15, mutable: false, hidden: false, kind: 'let' },
    ])
  })

  test('match: $subject, arm bindings and the guard-failure range', () => {
    const source = 'let v = match 1 { x if x > 0 => x, _ => 0 }'
    const script = compileOk(source).script
    // 0 Const, 2 MatchPattern, 5 Declare, 7 GetLocal, 9 Const, 11 Gt, 12 JumpIfFalse,
    // 14 GetLocal, 16 EndScope 1, 18 Jump, 20 PopN 1, 22 MatchPattern, ...
    const locals = visibleLocals(script)
    expect(locals.filter((l) => l.name === 'x')).toEqual([
      { name: 'x', slot: 2, startIp: 7, endIp: 18, mutable: false, hidden: false, kind: 'match' },
      { name: 'x', slot: 2, startIp: 20, endIp: 22, mutable: false, hidden: false, kind: 'match' },
    ])
    const subject = locals.find((l) => l.name === '$subject')
    expect(subject).toEqual({
      name: '$subject',
      slot: 1,
      startIp: 2,
      endIp: script.code.indexOf(Op.DefineGlobal, 22),
      mutable: false,
      hidden: true,
      kind: 'hidden',
    })
  })

  test('a local fn starts after its Declare and the body block never ends parameters', () => {
    const source = '{ fn f(n) { let m = n; m } }'
    const program = compileOk(source)
    expect(visibleLocals(program.script)).toEqual([
      { name: 'f', slot: 1, startIp: 4, endIp: 6, mutable: false, hidden: false, kind: 'fn' },
    ])
    const f = program.protos[1]!
    expect(visibleLocals(f).find((l) => l.name === 'n')?.endIp).toBe(f.code.length)
  })

  test('declSpan is the binding name', () => {
    const source = '{ let [a, ...rest] = [1]; fn g() { 1 } }'
    const locals = compileOk(source).script.debug.locals
    expect(locals.map((l) => [l.name, l.declSpan])).toEqual([
      ['a', spanOf(source, 'a')],
      ['rest', spanOf(source, 'rest')],
      ['g', spanOf(source, 'g')],
    ])
  })
})

describe('protos, names and globals', () => {
  test('display names follow SPEC §7.12', () => {
    const source = [
      'fn named() { 1 }',
      'let f = fn() { 1 }',
      'var g = (|x| x)',
      'let h = [|x| x][0]',
      'var k = nil',
      'k = |x| x',
      'let [p] = [|x| x]',
    ].join('\n')
    const program = compileOk(source)
    expect(program.protos.map((p) => p.name)).toEqual([
      '<top level>',
      'named',
      'f',
      'g',
      null,
      null,
      null,
    ])
    expect(program.script.kind).toBe('script')
    expect(program.protos[1]!.kind).toBe('function')
  })

  test('protos are numbered from firstProtoId in creation order, script first', () => {
    const program = compileOk('fn a() { fn b() { 1 }; b }\nfn c() { 2 }', 'main', 30)
    expect(program.protos.map((p) => [p.id, p.name])).toEqual([
      [30, '<top level>'],
      [31, 'a'],
      [32, 'b'],
      [33, 'c'],
    ])
    expect(program.firstProtoId).toBe(30)
    expect(program.script).toBe(program.protos[0])
  })

  test('upvalue names and counts', () => {
    const source = '{ let a = 1; var b = 2; let f = || || a + b + a }'
    const program = compileOk(source)
    expect(program.protos[1]!.debug.upvalueNames).toEqual(['a', 'b'])
    expect(program.protos[2]!.debug.upvalueNames).toEqual(['a', 'b'])
    expect(program.protos[2]!.upvalueCount).toBe(2)
  })

  test('Program.globals lists first declarations with kind and mutability', () => {
    const source = 'let a = 1\nvar [b, c] = [1, 2]\nfn d() { 1 }\n{ let local = 1 }'
    const program = compileOk(source)
    expect(program.globals).toEqual([
      { name: 'a', kind: 'let', mutable: false, declSpan: spanOf(source, 'a') },
      { name: 'b', kind: 'var', mutable: true, declSpan: spanOf(source, 'b') },
      { name: 'c', kind: 'var', mutable: true, declSpan: spanOf(source, 'c') },
      { name: 'd', kind: 'fn', mutable: false, declSpan: spanOf(source, 'd') },
    ])
    expect(program.diagnostics).toEqual([])
    expect(program.source).toBe(source)
  })

  test('debug metadata of main code', () => {
    const source = 'let f = |x| x'
    const program = compileOk(source)
    expect(program.script.debug).toMatchObject({
      source: 'main',
      library: false,
      span: { start: 0, end: source.length },
    })
    expect(program.protos[1]!.debug.span).toEqual(spanOf(source, '|x| x'))
  })
})
