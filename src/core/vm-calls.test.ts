import { describe, expect, test } from 'vitest'
import { printed, runAsm } from './testing/vm-harness'

const ADD = `
.fn add arity=2
GetLocal 1
GetLocal 2
Add
Return
.end`

describe('calls and returns (SPEC §7.10)', () => {
  test('a closure call binds parameters and returns its result', () => {
    const text = `Closure add\nDefineGlobal add\nGetBuiltin print\nGetGlobal add\nConst 2\nConst 3\nCall 2\nCall 1\nPop\nNil\nReturn${ADD}`
    expect(printed(text)).toEqual(['5'])
  })

  test('a finished run leaves no frames and an empty stack', () => {
    const run = runAsm('Const 1\nPop\nNil\nReturn')
    expect(run.vm.status).toBe('finished')
    expect(run.vm.frames).toHaveLength(0)
    expect(run.vm.stack).toHaveLength(0)
    expect(run.vm.time).toBe(4)
  })

  test('calling a non-function is R004', () => {
    const run = runAsm('Const 1\nCall 0\nReturn')
    expect(run.error).toMatchObject({ code: 'R004', message: 'cannot call a number' })
  })

  test.each([
    ['Closure add\nConst 1\nCall 1', "'add' expects 2 arguments but got 1"],
    ['Closure f\nCall 0', 'lambda expects 1 argument but got 0'],
    ['GetBuiltin len\nConst 1\nConst 2\nCall 2', "'len' expects 1 argument but got 2"],
    ['GetBuiltin range\nCall 0', "'range' expects 1 to 3 arguments but got 0"],
    ['GetBuiltin min\nCall 0', "'min' expects at least 1 argument but got 0"],
    ['GetBuiltin random\nConst 1\nCall 1', "'random' expects 0 arguments but got 1"],
  ])('arity errors are R005: %s', (body, message) => {
    const run = runAsm(`${body}\nReturn${ADD}\n.fn f arity=1 anon\nNil\nReturn\n.end`)
    expect(run.error).toMatchObject({ code: 'R005', message })
  })

  test('R016 is raised at the 10,001st active call, not before', () => {
    const recursion = (n: number): string => `
Closure d
DefineGlobal d
GetBuiltin print
GetGlobal d
Const ${n}
Call 1
Call 1
Pop
Nil
Return
.fn d arity=1
GetLocal 1
Const 0
Eq
JumpIfFalse @rec
Const 0
Return
@rec: Const 1
GetGlobal d
GetLocal 1
Const 1
Sub
Call 1
Add
Return
.end`
    expect(printed(recursion(9999))).toEqual(['9999'])
    const run = runAsm(recursion(10000))
    expect(run.error).toMatchObject({
      code: 'R016',
      message: 'stack overflow: more than 10000 nested calls',
    })
    expect(run.error!.stack).toHaveLength(10001)
  })
})

describe('closures and cells (SPEC §5.6)', () => {
  test('a returned closure keeps its closed cell', () => {
    const text = `
Closure makeCounter
Call 0
Declare 1
GetBuiltin print
GetLocal 1
Call 0
GetLocal 1
Call 0
Call 2
Pop
Nil
Return
.fn makeCounter
Const 0
Declare 1
Closure inc local 1
Return
.end
.fn inc upvalues=1
GetUpvalue 0
Const 1
Add
SetUpvalue 0
GetUpvalue 0
Return
.end`
    expect(printed(text)).toEqual(['1 2'])
  })

  test('an open cell aliases the stack slot in both directions', () => {
    const text = `
Const 1
Declare 1
Closure bump local 1
Declare 1
Const 5
SetLocal 1
GetLocal 2
Call 0
Pop
GetBuiltin print
GetLocal 1
Call 1
Pop
Nil
Return
.fn bump upvalues=1
GetUpvalue 0
Const 10
Add
SetUpvalue 0
Nil
Return
.end`
    expect(printed(text)).toEqual(['15'])
  })

  test('closures created in different loop iterations capture different variables', () => {
    const text = `
List 0
Declare 1
Const 1
Const 4
Range 0
IterInit
@next: IterNext @done
Declare 1
GetBuiltin push
GetLocal 1
Closure getx local 3
Call 2
Pop
PopN 1
Jump @next
@done: Pop
GetBuiltin print
GetLocal 1
Const 0
GetIndex
Call 0
GetLocal 1
Const 2
GetIndex
Call 0
Call 2
Pop
Nil
Return
.fn getx upvalues=1
GetUpvalue 0
Return
.end`
    expect(printed(text)).toEqual(['1 3'])
  })

  test('EndScope closes the cells of the removed slots', () => {
    const text = `
Const 7
Closure getx local 1
EndScope 1
Declare 1
GetBuiltin print
GetLocal 1
Call 0
Call 1
Pop
Nil
Return
.fn getx upvalues=1
GetUpvalue 0
Return
.end`
    const run = runAsm(text)
    expect(run.outputs).toEqual(['7'])
    expect(run.vm.openCells).toHaveLength(0)
  })

  test('a closure can capture its own slot and an enclosing upvalue', () => {
    const text = `
Const 3
Declare 1
Closure outer local 1
Call 0
Pop
Nil
Return
.fn outer upvalues=1
Closure inner upvalue 0 local 1
Declare 1
GetBuiltin print
GetLocal 1
Call 0
Call 1
Pop
Nil
Return
.end
.fn inner upvalues=2
GetUpvalue 0
GetUpvalue 1
Return
.end`
    // Closure inner sits in slot 1 of outer, so its second capture is itself.
    expect(printed(text.replace('.fn outer\n', '.fn outer upvalues=1\n'))).toEqual(['<fn inner>'])
  })

  test('nested open cells are kept sorted by stack index', () => {
    const text = `
Const 1
Const 2
Declare 2
Closure two local 2 local 1
Pop
Closure one local 1
Pop
Nil
Return
.fn two upvalues=2
Nil
Return
.end
.fn one upvalues=1
Nil
Return
.end`
    const run = runAsm(text, { maxSteps: 7 })
    expect(run.vm.openCells.map((cell) => cell.stackIndex)).toEqual([1, 2])
  })
})

describe('runtime error infos (SPEC §10.4)', () => {
  test('the span is the failing instruction and the stack lists callers innermost first', () => {
    const text = `
Closure f
.span 10 15
Call 0
Return
.fn f
Const 1
Const 0
.span 30 35
Div
Return
.end`
    const run = runAsm(text)
    expect(run.error).toEqual({
      code: 'R002',
      message: 'division by zero',
      span: { start: 30, end: 35 },
      stack: [
        { name: 'f', span: { start: 30, end: 35 }, library: false },
        { name: '<top level>', span: { start: 10, end: 15 }, library: false },
      ],
      time: 4,
    })
    expect(run.vm.status).toBe('error')
    expect(run.vm.time).toBe(4)
  })

  test('failures inside library code are reported at the user call that entered it', () => {
    const text = `
Closure lib
.span 5 9
Call 0
Return
.fn lib library
GetBuiltin len
Const 1
.span 100 110
Call 1
Return
.end`
    const run = runAsm(text)
    expect(run.error).toMatchObject({
      code: 'R019',
      message: "'len' expects a list, string, record or range as argument 1, got a number",
      span: { start: 5, end: 9 },
      stack: [
        { name: 'lib', span: { start: 100, end: 110 }, library: true },
        { name: '<top level>', span: { start: 5, end: 9 }, library: false },
      ],
    })
  })

  test('a user callback failing under library code keeps its own span', () => {
    const text = `
Closure lib
Closure cb
.span 1 2
Call 1
Return
.fn lib arity=1 library
GetLocal 1
.span 50 60
Call 0
Return
.end
.fn cb anon
Nil
Neg
.span 0 0
Return
.end`
    const run = runAsm(text.replace('Nil\nNeg', '.span 70 75\nNil\nNeg'))
    expect(run.error!.span).toEqual({ start: 70, end: 75 })
    expect(run.error!.stack.map((entry) => entry.name)).toEqual(['lambda', 'lib', '<top level>'])
  })

  test('step() after the run ended is an internal error', () => {
    const run = runAsm('Nil\nReturn')
    expect(() => run.vm.step()).toThrow(/internal error/)
  })

  test('protoById finds program protos and rejects unknown ids', () => {
    const run = runAsm(`Nil\nReturn${ADD}`, { firstProtoId: 3 })
    expect(run.vm.protoById(3).name).toBe('<top level>')
    expect(run.vm.protoById(4).name).toBe('add')
    expect(() => run.vm.protoById(0)).toThrow(/no proto/)
    expect(() => run.vm.protoById(9)).toThrow(/no proto/)
  })
})
