import { describe, expect, test } from 'vitest'
import { printed, runAsm } from './testing/vm-harness'

/** A script that prints the values the given instructions push (`count` of them). */
function printing(body: string, count = 1): string {
  return `GetBuiltin print\n${body}\nCall ${count}\nPop\nNil\nReturn`
}

function out(body: string, count = 1): string {
  return printed(printing(body, count)).join('\n')
}

function failure(text: string): { code: string; message: string; hint?: string } {
  const run = runAsm(text)
  if (run.error === null) throw new Error('expected a runtime error')
  const { code, message, hint } = run.error
  return hint === undefined ? { code, message } : { code, message, hint }
}

function binary(a: string, op: string, b: string): string {
  return out(`Const ${a}\nConst ${b}\n${op}`)
}

describe('constants and stack operations', () => {
  test('Const, Nil, True and False push their values', () => {
    expect(out('Const 1.5\nConst "hi"\nNil\nTrue\nFalse', 5)).toBe('1.5 hi nil true false')
  })

  test('Pop discards the top value', () => {
    expect(out('Const 1\nConst 2\nPop')).toBe('1')
  })

  test('PopN removes n values', () => {
    expect(out('Const 1\nConst 2\nConst 3\nPopN 2')).toBe('1')
  })

  test('EndScope removes n values below the kept top', () => {
    expect(out('Const 1\nConst 2\nConst 3\nEndScope 1', 2)).toBe('1 3')
  })

  test('Dup and Dup2 copy the top values', () => {
    expect(out('Const 1\nDup', 2)).toBe('1 1')
    expect(out('Const 1\nConst 2\nDup2', 4)).toBe('1 2 1 2')
  })
})

describe('locals and globals', () => {
  test('GetLocal and SetLocal address slots from the frame base', () => {
    const text = `Const 10\nDeclare 1\nConst 20\nSetLocal 1\nGetBuiltin print\nGetLocal 1\nCall 1\nPop\nNil\nReturn`
    expect(printed(text)).toEqual(['20'])
  })

  test('DefineGlobal, GetGlobal and SetGlobal', () => {
    const text = `Const 1\nDefineGlobal x\nConst 2\nSetGlobal x\n${printing('GetGlobal x')}`
    expect(printed(text)).toEqual(['2'])
  })

  test('reading a global before it is defined is R006', () => {
    expect(failure('.span 3 4\nGetGlobal x\nReturn')).toEqual({
      code: 'R006',
      message: "'x' was used before it was defined",
    })
  })

  test('assigning a global before it is defined is R006', () => {
    expect(failure('Const 1\nSetGlobal "y"\nNil\nReturn').message).toBe(
      "'y' was used before it was defined",
    )
  })

  test('GetBuiltin pushes a builtin and DefineBuiltin stores one', () => {
    expect(out('GetBuiltin len')).toBe('<builtin len>')
    const text = `GetBuiltin str\nDefineBuiltin map\n${printing('GetBuiltin map')}`
    expect(printed(text)).toEqual(['<builtin str>'])
  })

  test('PI and INF are numbers', () => {
    expect(out('GetBuiltin PI\nGetBuiltin INF', 2)).toBe(`${Math.PI} Infinity`)
  })
})

describe('arithmetic (SPEC §7.2)', () => {
  test('number operators follow JavaScript', () => {
    expect(binary('7', 'Add', '5')).toBe('12')
    expect(binary('7', 'Sub', '5')).toBe('2')
    expect(binary('7', 'Mul', '5')).toBe('35')
    expect(binary('7', 'Div', '2')).toBe('3.5')
    expect(binary('2', 'Pow', '10')).toBe('1024')
    expect(binary('2', 'Pow', '2000')).toBe('Infinity')
    expect(out('Const 5\nNeg')).toBe('-5')
  })

  test.each([
    ['-7', '3', '2'],
    ['7', '-3', '-2'],
    ['-7', '-3', '-1'],
    ['7', '3', '1'],
    ['6', '-3', '0'],
    ['5', 'Infinity', '5'],
    ['-5', 'Infinity', 'Infinity'],
    ['5.5', '2', '1.5'],
  ])('%s %% %s == %s (floored modulo)', (a, b, expected) => {
    expect(binary(a, 'Mod', b)).toBe(expected)
  })

  test('+ concatenates strings and lists', () => {
    expect(binary('"ab"', 'Add', '"cd"')).toBe('abcd')
    expect(out('Const 1\nList 1\nConst 2\nList 1\nAdd')).toBe('[1, 2]')
  })

  test('+ on a string and a number is R001 with the hint', () => {
    expect(failure('Const "a"\nConst 1\nAdd\nReturn')).toEqual({
      code: 'R001',
      message: "cannot apply '+' to string and number",
      hint: 'convert with str() or use interpolation, e.g. "{x}"',
    })
    expect(failure('Const 1\nConst "a"\nAdd\nReturn').hint).toBeDefined()
  })

  test('+ on other mixes is R001 without a hint', () => {
    expect(failure('Const 1\nNil\nAdd\nReturn')).toEqual({
      code: 'R001',
      message: "cannot apply '+' to number and nil",
    })
  })

  test.each([
    ['Sub', '-'],
    ['Mul', '*'],
    ['Div', '/'],
    ['Mod', '%'],
    ['Pow', '**'],
  ])('%s on a non-number is R001 naming %s', (op, symbol) => {
    expect(failure(`True\nConst 1\n${op}\nReturn`)).toEqual({
      code: 'R001',
      message: `cannot apply '${symbol}' to bool and number`,
    })
  })

  test('division and modulo by zero are R002', () => {
    expect(failure('Const 1\nConst 0\nDiv\nReturn')).toEqual({
      code: 'R002',
      message: 'division by zero',
    })
    expect(failure('Const 1\nConst -0\nMod\nReturn').code).toBe('R002')
  })

  test('unary minus on a non-number is R001 (unary form)', () => {
    expect(failure('Const "x"\nNeg\nReturn').message).toBe("cannot apply '-' to string")
  })

  test('Not negates truthiness', () => {
    expect(out('Const 0\nNot\nNil\nNot', 2)).toBe('false true')
  })
})

describe('comparison and equality (SPEC §7.3, §7.4)', () => {
  test('numbers and strings compare in order', () => {
    expect(binary('1', 'Lt', '2')).toBe('true')
    expect(binary('2', 'Le', '2')).toBe('true')
    expect(binary('1', 'Gt', '2')).toBe('false')
    expect(binary('2', 'Ge', '3')).toBe('false')
    expect(binary('"a"', 'Lt', '"b"')).toBe('true')
    expect(binary('"B"', 'Gt', '"a"')).toBe('false')
    expect(binary('"a"', 'Le', '"a"')).toBe('true')
    expect(binary('"b"', 'Ge', '"a"')).toBe('true')
  })

  test('comparing mixed types is R001', () => {
    expect(failure('Const 1\nConst "a"\nLt\nReturn').message).toBe(
      "cannot apply '<' to number and string",
    )
  })

  test('equality is structural, NaN is unequal and -0 equals 0', () => {
    expect(out('Const 1\nList 1\nConst 1\nList 1\nEq')).toBe('true')
    expect(binary('NaN', 'Eq', 'NaN')).toBe('false')
    expect(binary('NaN', 'Ne', 'NaN')).toBe('true')
    expect(binary('0', 'Eq', '-0')).toBe('true')
    expect(binary('1', 'Eq', '"1"')).toBe('false')
  })
})

describe('ranges', () => {
  test('Range 0 and Range 1 build exclusive and inclusive ranges', () => {
    expect(out('Const 1\nConst 5\nRange 0\nConst 1\nConst 5\nRange 1', 2)).toBe('1..5 1..=5')
  })

  test('non-number bounds are R001 naming the operator', () => {
    expect(failure('Const 1\nNil\nRange 1\nReturn').message).toBe(
      "cannot apply '..=' to number and nil",
    )
    expect(failure('Nil\nConst 1\nRange 0\nReturn').message).toBe(
      "cannot apply '..' to nil and number",
    )
  })
})

describe('jumps', () => {
  test('Jump skips code', () => {
    expect(out('Const 1\nJump @x\nConst 2\nPop\n@x:')).toBe('1')
  })

  test('JumpIfFalse pops and jumps on falsy values only', () => {
    const text = (cond: string): string =>
      out(`${cond}\nJumpIfFalse @no\nConst "yes"\nJump @end\n@no: Const "no"\n@end:`)
    expect(text('Const 0')).toBe('yes')
    expect(text('Nil')).toBe('no')
    expect(text('False')).toBe('no')
  })

  test('AndJump keeps a falsy left operand and otherwise evaluates the right', () => {
    expect(out('False\nAndJump @end\nConst 2\n@end:')).toBe('false')
    expect(out('Const 1\nAndJump @end\nConst 2\n@end:')).toBe('2')
  })

  test('OrJump keeps a truthy left operand and otherwise evaluates the right', () => {
    expect(out('Const 1\nOrJump @end\nConst 2\n@end:')).toBe('1')
    expect(out('Nil\nOrJump @end\nConst 2\n@end:')).toBe('2')
  })
})

describe('fields and indexing (SPEC §7.7, §7.9)', () => {
  const rec = 'Const "a"\nConst 1\nConst "bb"\nConst 2\nRecord 2'

  test('GetField reads and SetField creates fields last', () => {
    expect(out(`${rec}\nGetField a`)).toBe('1')
    const text = `${rec}\nDeclare 1\nGetLocal 1\nConst 3\nSetField c\nGetLocal 1\nConst 9\nSetField a\n${printing('GetLocal 1')}`
    expect(printed(text)).toEqual(['{a: 9, bb: 2, c: 3}'])
  })

  test('a missing field is R010 with a did-you-mean hint', () => {
    expect(failure(`${rec}\nGetField bbb\nReturn`)).toEqual({
      code: 'R010',
      message: "record has no field 'bbb'",
      hint: "did you mean 'bb'?",
    })
    expect(failure(`${rec}\nGetField b\nReturn`).hint).toBeUndefined()
    expect(failure(`${rec}\nGetField zzzz\nReturn`)).toEqual({
      code: 'R010',
      message: "record has no field 'zzzz'",
    })
  })

  test('fields of non-records are R011', () => {
    expect(failure('Const 1\nGetField x\nReturn').message).toBe("cannot read field 'x' of a number")
    expect(failure('Nil\nConst 1\nSetField x\nReturn').message).toBe("cannot set field 'x' on nil")
  })

  test('list indexing supports negative indices and reports R007/R008', () => {
    const list = 'Const 10\nConst 20\nConst 30\nList 3'
    expect(out(`${list}\nConst 1\nGetIndex`)).toBe('20')
    expect(out(`${list}\nConst -1\nGetIndex`)).toBe('30')
    expect(failure(`${list}\nConst -4\nGetIndex\nReturn`)).toEqual({
      code: 'R007',
      message: 'index -4 is out of bounds for a list of length 3',
    })
    expect(failure(`${list}\nConst 1.5\nGetIndex\nReturn`)).toEqual({
      code: 'R008',
      message: 'list index must be an integer, got 1.5',
    })
    expect(failure(`${list}\nConst "x"\nGetIndex\nReturn`).message).toBe(
      'list index must be an integer, got "x"',
    )
  })

  test('list element writes never grow the list', () => {
    const text = `Const 1\nConst 2\nList 2\nDeclare 1\nGetLocal 1\nConst -1\nConst 9\nSetIndex\n${printing('GetLocal 1')}`
    expect(printed(text)).toEqual(['[1, 9]'])
    expect(failure('Const 1\nList 1\nConst 1\nConst 0\nSetIndex\nReturn').code).toBe('R007')
  })

  test('string indexing yields one code unit; writes are R022 first', () => {
    expect(out('Const "abc"\nConst -1\nGetIndex')).toBe('c')
    expect(failure('Const "abc"\nConst 5\nGetIndex\nReturn').message).toBe(
      'index 5 is out of bounds for a string of length 3',
    )
    expect(failure('Const "abc"\nNil\nConst 1\nSetIndex\nReturn')).toEqual({
      code: 'R022',
      message: 'cannot assign into a string: strings are immutable',
    })
  })

  test('record indexing requires string keys', () => {
    expect(out(`${rec}\nConst "bb"\nGetIndex`)).toBe('2')
    expect(failure(`${rec}\nConst 1\nGetIndex\nReturn`)).toEqual({
      code: 'R012',
      message: 'record keys must be strings, got a number',
    })
    expect(failure(`${rec}\nConst 1\nConst 2\nSetIndex\nReturn`).code).toBe('R012')
    expect(failure(`${rec}\nConst "c"\nGetIndex\nReturn`).code).toBe('R010')
    const text = `${rec}\nDeclare 1\nGetLocal 1\nConst "z z"\nConst 5\nSetIndex\n${printing('GetLocal 1')}`
    expect(printed(text)).toEqual(['{a: 1, bb: 2, "z z": 5}'])
  })

  test('indexing anything else is R009 without examining the index', () => {
    expect(failure('Const 1\nConst 2\nRange 0\nNil\nGetIndex\nReturn')).toEqual({
      code: 'R009',
      message: 'cannot index a range',
    })
    expect(failure('Nil\nNil\nNil\nSetIndex\nReturn').message).toBe('cannot index nil')
  })
})

describe('list and record literals (SPEC §7.8, §7.9)', () => {
  test('List, ListAppend and ListExtend build lists from items and iterables', () => {
    const body =
      'Const 1\nList 1\nConst 2\nListAppend\nConst 3\nConst 5\nRange 0\nListExtend\nConst "ab"\nListExtend'
    expect(out(body)).toBe('[1, 2, 3, 4, "a", "b"]')
  })

  test('spreading a record yields its keys', () => {
    expect(out('List 0\nConst "k"\nConst 1\nRecord 1\nListExtend')).toBe('["k"]')
  })

  test('spreading a non-iterable is R013', () => {
    expect(failure('List 0\nConst 1\nListExtend\nReturn')).toEqual({
      code: 'R013',
      message: 'cannot iterate over a number',
    })
  })

  test('Record keeps the first position of a repeated key', () => {
    expect(out('Const "a"\nConst 1\nConst "b"\nConst 2\nConst "a"\nConst 3\nRecord 3')).toBe(
      '{a: 3, b: 2}',
    )
  })

  test('RecordSet and RecordMerge add entries', () => {
    const body =
      'Record 0\nConst "x"\nConst 1\nRecordSet\nConst "y"\nConst 2\nConst "x"\nConst 3\nRecord 2\nRecordMerge'
    expect(out(body)).toBe('{x: 3, y: 2}')
  })

  test('merging a non-record is R024', () => {
    expect(failure('Record 0\nConst 1\nList 1\nRecordMerge\nReturn')).toEqual({
      code: 'R024',
      message: 'cannot spread a list into a record',
    })
  })

  test('Interp concatenates show of each value', () => {
    expect(out('Const "n = "\nConst 1\nConst "s"\nList 2\nConst "!"\nInterp 3')).toBe(
      'n = [1, "s"]!',
    )
  })
})

describe('size limits (SPEC §10.5)', () => {
  const maxString = 'GetBuiltin repeat\nConst "x"\nConst 16777216\nCall 2'
  const maxList = 'GetBuiltin list\nConst 0\nConst 16777216\nRange 0\nCall 1'
  const tooLarge = { code: 'R025', message: 'result too large' }

  test('string concatenation and interpolation are checked before building', () => {
    expect(failure(`${maxString}\nConst "y"\nAdd\nReturn`)).toEqual(tooLarge)
    expect(failure(`${maxString}\nConst 1\nInterp 2\nReturn`)).toEqual(tooLarge)
    expect(runAsm(`${maxString}\nConst ""\nAdd\nPop\nNil\nReturn`).error).toBeNull()
  })

  test('lists cannot grow beyond 2^24 items', () => {
    expect(failure(`${maxList}\nConst 1\nListAppend\nReturn`)).toEqual(tooLarge)
    expect(failure(`${maxList}\nConst "a"\nListExtend\nReturn`)).toEqual(tooLarge)
    expect(failure(`${maxList}\nConst 1\nList 1\nAdd\nReturn`)).toEqual(tooLarge)
  })
})
