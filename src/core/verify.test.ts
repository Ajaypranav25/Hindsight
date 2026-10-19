import { describe, expect, test } from 'vitest'
import type { Constant, FunctionProto, LocalInfo, PatternConst, Program } from './bytecode'
import { Op } from './bytecode'
import { compileOk } from './compiler/test-support'
import { verifyProgram, verifyProto } from './verify'

const PATTERN: PatternConst = { tag: 'pattern', desc: { t: 'bind' }, text: 'x', bindCount: 1 }

interface ProtoParts {
  readonly constants?: Constant[]
  readonly arity?: number
  readonly upvalueCount?: number
  readonly locals?: LocalInfo[]
  readonly stmtStart?: number[]
  readonly debugLength?: number
  readonly upvalueNames?: string[]
}

/** A proto with consistent debug tables unless `parts` says otherwise. */
function makeProto(code: number[], parts: ProtoParts = {}, id = 0): FunctionProto {
  const length = parts.debugLength ?? code.length
  const stmtStart = new Uint8Array(length)
  for (const ip of parts.stmtStart ?? []) stmtStart[ip] = 1
  const upvalueCount = parts.upvalueCount ?? 0
  return {
    tag: 'proto',
    id,
    name: 'p',
    kind: 'function',
    arity: parts.arity ?? 0,
    code,
    constants: parts.constants ?? [],
    upvalueCount,
    debug: {
      source: 'main',
      library: false,
      span: { start: 0, end: 0 },
      spanStart: new Int32Array(length),
      spanEnd: new Int32Array(length),
      stmtStart,
      stmtSpanStart: new Int32Array(length),
      stmtSpanEnd: new Int32Array(length),
      locals: parts.locals ?? [],
      upvalueNames: parts.upvalueNames ?? Array.from({ length: upvalueCount }, () => 'u'),
    },
  }
}

function local(slot: number, startIp: number, endIp: number): LocalInfo {
  return {
    name: 'l',
    slot,
    startIp,
    endIp,
    mutable: false,
    hidden: false,
    kind: 'let',
    declSpan: { start: 0, end: 0 },
  }
}

function problems(code: number[], parts: ProtoParts = {}): string {
  return verifyProto(makeProto(code, parts)).join('\n')
}

describe('verifyProto', () => {
  test('accepts a well-formed proto', () => {
    expect(problems([Op.Nil, Op.Return])).toBe('')
  })

  test('decoding errors', () => {
    expect(problems([99, Op.Nil, Op.Return])).toContain('ip 0: invalid opcode 99')
    expect(problems([Op.Nil, Op.Const])).toContain('Const operands run past the end')
    expect(problems([Op.Const, -1, Op.Return])).toContain('invalid operand -1')
    expect(problems([Op.Const, 0.5, Op.Return])).toContain('invalid operand 0.5')
    expect(problems([])).toContain('empty code')
  })

  test('constant operands', () => {
    expect(problems([Op.Const, 3, Op.Return])).toContain('Const constant 3 is out of range')
    const constants: Constant[] = [PATTERN, 1]
    expect(problems([Op.Const, 0, Op.Return], { constants })).toContain(
      'Const 0 is not a number or string',
    )
    expect(problems([Op.GetGlobal, 1, Op.Return], { constants })).toContain('is not a name')
    expect(
      problems([Op.Nil, Op.Destructure, 1, Op.Pop, Op.Nil, Op.Return], { constants }),
    ).toContain('Destructure constant 1 is not a pattern')
  })

  test('jump targets must be instruction starts', () => {
    expect(problems([Op.Jump, 1, Op.Nil, Op.Return])).toContain(
      'jump target 1 is not an instruction',
    )
    const code = [Op.Nil, Op.MatchPattern, 0, 9, Op.Return]
    expect(problems(code, { constants: [PATTERN] })).toContain(
      'jump target 9 is not an instruction',
    )
  })

  test('builtin, upvalue, count and flag operands', () => {
    expect(problems([Op.GetBuiltin, 999, Op.Return])).toContain('builtin index 999 is out of range')
    expect(problems([Op.GetUpvalue, 0, Op.Return])).toContain('upvalue 0 is out of range')
    expect(problems([Op.Nil, Op.Nil, Op.PopN, 0, Op.Return])).toContain(
      'PopN needs a positive count',
    )
    expect(problems([Op.Nil, Op.Nil, Op.Range, 2, Op.Return])).toContain(
      'Range flag 2 must be 0 or 1',
    )
  })

  test('stack underflow and inconsistent depths at joins', () => {
    expect(problems([Op.Pop, Op.Pop, Op.Nil, Op.Return])).toContain(
      'stack underflow: Pop needs 1, depth 0',
    )
    const join = [Op.True, Op.JumpIfFalse, 4, Op.Nil, Op.Nil, Op.Return]
    expect(problems(join)).toContain('inconsistent stack depth at 4: 1 vs 2')
  })

  test('code must not fall off the end', () => {
    expect(problems([Op.Nil])).toContain('execution runs past the end of the code')
  })

  test('local and capture slots must be inside the frame', () => {
    expect(problems([Op.GetLocal, 5, Op.Return])).toContain('local slot 5 is outside the frame')
    expect(problems([Op.GetLocal, 1, Op.Return], { arity: 1 })).toBe('')
    const callee = makeProto([Op.Nil, Op.Return], { upvalueCount: 1 }, 1)
    const capture = (isLocal: number, index: number): string =>
      problems([Op.Closure, 0, isLocal, index, Op.Return], { constants: [callee] })
    expect(capture(1, 1)).toBe('')
    expect(capture(1, 2)).toContain('captured slot 2 is outside the frame')
    expect(capture(2, 0)).toContain('capture flag 2 must be 0 or 1')
    expect(capture(0, 0)).toContain('captured upvalue 0 is out of range')
    expect(problems([Op.Closure, 0, Op.Return], { constants: [1] })).toContain(
      'Closure operand is not a function constant',
    )
  })

  test('debug tables', () => {
    expect(problems([Op.Nil, Op.Return], { debugLength: 1 })).toContain(
      'debug.spanStart has length 1, expected 2',
    )
    expect(problems([Op.Const, 0, Op.Return], { constants: [1], stmtStart: [0, 1] })).toContain(
      'ip 1: stmtStart set on an operand',
    )
    expect(problems([Op.Nil, Op.Return], { upvalueNames: ['x'] })).toContain(
      '1 upvalue names for 0 upvalues',
    )
  })

  test('local live ranges and slots', () => {
    const code = [Op.Nil, Op.Declare, 1, Op.Return]
    expect(problems(code, { locals: [local(1, 3, 4)] })).toBe('')
    expect(problems(code, { locals: [local(0, 3, 4)] })).toContain("local 'l' has slot 0")
    expect(problems(code, { locals: [local(1, 4, 3)] })).toContain('invalid range [4, 3)')
    expect(problems(code, { locals: [local(1, 0, 9)] })).toContain('invalid range [0, 9)')
    expect(problems(code, { locals: [local(2, 3, 4)] })).toContain(
      "local 'l' slot 2 is outside the frame (depth 2)",
    )
  })
})

describe('verifyProgram', () => {
  test('accepts compiled programs', () => {
    expect(verifyProgram(compileOk('fn f(x) { || x }\nprint(f(1)())'))).toEqual([])
  })

  test('checks numbering, nesting and the script', () => {
    const program = compileOk('fn f() { 1 }')
    const stray = makeProto([Op.Nil, Op.Return], {}, 42)
    const fake: FunctionProto = { ...program.protos[0]!, constants: [stray], kind: 'function' }
    const broken: Program = { ...program, script: fake, protos: [program.protos[1]!, fake] }
    const errors = verifyProgram(broken).join('\n')
    expect(errors).toContain('proto at index 0 has id 1, expected 0')
    expect(errors).toContain('references proto #42 outside the program')
    expect(errors).toContain('the script is not the first proto')
    expect(errors).toContain("the script proto's kind is not 'script'")
  })
})
