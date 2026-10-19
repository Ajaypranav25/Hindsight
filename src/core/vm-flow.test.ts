import { describe, expect, test } from 'vitest'
import { printed, runAsm } from './testing/vm-harness'

/** `for x in <iterable code> { print(x) ; <extra body> }` with the element in slot 2 + depth. */
function forPrint(iterable: string, extraBody = '', preamble = ''): string {
  return `${preamble}
${iterable}
IterInit
@next: IterNext @done
Declare 1
GetBuiltin print
GetLocal SLOT
Call 1
Pop
${extraBody}
PopN 1
Jump @next
@done: Pop
Nil
Return`
}

function loop(iterable: string, extraBody = '', preamble = '', slot = 2): string[] {
  return printed(forPrint(iterable, extraBody, preamble).replace('SLOT', String(slot)))
}

describe('iteration (SPEC §8.3)', () => {
  test('ranges yield start + k * step', () => {
    expect(loop('GetBuiltin range\nConst 0\nConst 10\nConst 3\nCall 3')).toEqual([
      '0',
      '3',
      '6',
      '9',
    ])
    expect(loop('Const 3\nConst 1\nRange 1')).toEqual([])
    expect(loop('GetBuiltin range\nConst 3\nConst 1\nConst -1\nCall 3')).toEqual(['3', '2'])
    expect(loop('Const 0.1\nConst 0.4\nRange 0')).toEqual(['0.1'])
    expect(loop('Const NaN\nConst 3\nRange 0')).toEqual([])
  })

  test('strings yield code units', () => {
    expect(loop('Const "ab"')).toEqual(['a', 'b'])
  })

  test('lists are re-checked against their current length', () => {
    // xs = [1, 2]; for x in xs { print(x); if x < 3 { push(xs, x + 2) } }
    const extra = `GetLocal 3
Const 3
Lt
JumpIfFalse @skip
GetBuiltin push
GetLocal 1
GetLocal 3
Const 2
Add
Call 2
Pop
@skip:`
    const preamble = 'Const 1\nConst 2\nList 2\nDeclare 1'
    expect(loop('GetLocal 1', extra, preamble, 3)).toEqual(['1', '2', '3', '4'])
  })

  test('records yield the keys snapshotted when the loop starts', () => {
    // r = {a: 1, b: 2}; for k in r { print(k); r.z = 0; delete(r, "b") }
    const extra = `GetLocal 1
Const 0
SetField z
GetBuiltin delete
GetLocal 1
Const "b"
Call 2
Pop`
    const preamble = 'Const "a"\nConst 1\nConst "b"\nConst 2\nRecord 2\nDeclare 1'
    expect(loop('GetLocal 1', extra, preamble, 3)).toEqual(['a', 'b'])
  })

  test('non-iterables are R013 at IterInit', () => {
    const run = runAsm('.span 0 9\nNil\nIterInit\nReturn')
    expect(run.error).toMatchObject({ code: 'R013', message: 'cannot iterate over nil' })
  })
})

const LIST_REST = JSON.stringify({
  desc: {
    t: 'list',
    before: [{ t: 'bind' }],
    rest: 'bind',
    after: [{ t: 'bind' }],
  },
  text: '[first, ...middle, last]',
})

/** Destructures the value built by `value` with `pattern` and prints the bindings. */
function destructure(value: string, pattern: string, bindings: number): string[] {
  return printed(`${value}
Destructure ${pattern}
Declare ${Math.max(bindings, 1)}
GetBuiltin print
${Array.from({ length: bindings }, (_, i) => `GetLocal ${i + 1}`).join('\n')}
Call ${bindings}
Pop
Nil
Return`)
}

describe('patterns (SPEC §6)', () => {
  test('list patterns bind items and allocate a new rest list', () => {
    const value = 'Const 1\nConst 2\nConst 3\nConst 4\nList 4'
    expect(destructure(value, LIST_REST, 3)).toEqual(['1 [2, 3] 4'])
    expect(destructure('Const 1\nConst 2\nList 2', LIST_REST, 3)).toEqual(['1 [] 2'])
  })

  test('a discarded rest and fixed-length lists', () => {
    const discard = JSON.stringify({
      t: 'list',
      before: [{ t: 'bind' }],
      rest: 'discard',
      after: [],
    })
    expect(destructure('Const 1\nConst 2\nList 2', discard, 1)).toEqual(['1'])
    const exact = JSON.stringify({
      t: 'list',
      before: [{ t: 'any' }, { t: 'bind' }],
      rest: 'none',
      after: [],
    })
    expect(destructure('Const 1\nConst 2\nList 2', exact, 1)).toEqual(['2'])
  })

  test('record patterns bind fields in field order and allow extra keys', () => {
    const pattern = JSON.stringify({
      t: 'record',
      fields: [
        { key: 'b', pattern: { t: 'bind' } },
        { key: 'x y', pattern: { t: 'lit', value: 1 } },
        { key: 'a', pattern: { t: 'bind' } },
      ],
    })
    const value =
      'Const "a"\nConst "A"\nConst "x y"\nConst 1\nConst "b"\nConst "B"\nConst "c"\nNil\nRecord 4'
    expect(destructure(value, pattern, 2)).toEqual(['B A'])
  })

  test('a mismatch is R014 with the truncated repr and the pattern text', () => {
    const items = Array.from({ length: 30 }, (_, i) => `Const ${i}`).join('\n')
    const exact = JSON.stringify({
      desc: { t: 'list', before: [], rest: 'none', after: [] },
      text: '[]',
    })
    const failed = runAsm(`${items}\nList 30\n.span 4 28\nDestructure ${exact}\nReturn`)
    const full = `[${Array.from({ length: 30 }, (_, i) => i).join(', ')}]`
    const repr = `${full.slice(0, 59)}…`
    expect(repr).toHaveLength(60)
    expect(failed.error).toMatchObject({
      code: 'R014',
      message: `value ${repr} does not match pattern []`,
      span: { start: 4, end: 28 },
    })
  })

  test('literal, range and alternative patterns', () => {
    const arms = (subject: string): string[] =>
      printed(`${subject}
@a1: MatchPattern {"t":"lit","value":"x"} @a2
GetBuiltin print
Const "lit"
Call 1
Pop
Jump @end
@a2: MatchPattern {"t":"range","start":0,"end":10,"inclusive":false} @a3
GetBuiltin print
Const "range"
Call 1
Pop
Jump @end
@a3: MatchPattern {"t":"or","alternatives":[{"t":"lit","value":null},{"t":"list","before":[{"t":"any"}],"rest":"none","after":[]}]} @a4
GetBuiltin print
Const "or"
Call 1
Pop
Jump @end
@a4: MatchPattern {"t":"bind"} @a5
Declare 1
GetBuiltin print
GetLocal 2
Call 1
Pop
EndScope 1
Pop
Jump @end
@a5: NoMatch
@end: Pop
Nil
Return`)
    expect(arms('Const "x"')).toEqual(['lit'])
    expect(arms('Const 5.5')).toEqual(['range'])
    expect(arms('Const 10')).toEqual(['10'])
    expect(arms('Nil')).toEqual(['or'])
    expect(arms('Const 7\nList 1')).toEqual(['or'])
    expect(arms('Const 7\nConst 8\nList 2')).toEqual(['[7, 8]'])
  })

  test('an inclusive range pattern accepts its end', () => {
    const run = runAsm(`Const 10
MatchPattern {"t":"range","start":0,"end":10,"inclusive":true} @no
Nil
Return
@no: NoMatch`)
    expect(run.error).toBeNull()
  })

  test('NoMatch is R015 with the subject', () => {
    const run = runAsm(`Const "s"
MatchPattern {"t":"lit","value":1} @no
Nil
Return
.span 2 3
@no: NoMatch`)
    expect(run.error).toMatchObject({
      code: 'R015',
      message: 'no match arm matched the value "s"',
      span: { start: 2, end: 3 },
    })
  })
})
