import { describe, expect, test } from 'vitest'
import { digest } from './testing/vm-digest'
import { type HookEvent, runAsm, startAsm } from './testing/vm-harness'

/** Events without the noise of `alloc` details beyond id and type. */
function eventsOf(text: string): HookEvent[] {
  const run = runAsm(text)
  if (run.error !== null) throw new Error(`${run.error.code}: ${run.error.message}`)
  return run.events
}

const CELLS = `
Const 1
Declare 1
Const 2
SetLocal 1
Closure f local 1
Declare 1
GetLocal 2
Const 9
Call 1
Pop
GetBuiltin print
Const "hi"
Call 1
Pop
Const 3
DefineGlobal g
Const 4
SetGlobal g
PopN 2
GetLocal 0
Pop
Nil
Return
.fn f arity=1 upvalues=1
GetLocal 1
SetUpvalue 0
Nil
Return
.end`

describe('hooks (ARCHITECTURE §6.7)', () => {
  test('locals, parameters, open cells, output and globals', () => {
    expect(eventsOf(CELLS)).toEqual([
      { e: 'declare', time: 1, target: { kind: 'local', frameUid: 1, slot: 1 }, value: 1 },
      { e: 'write', time: 3, target: { kind: 'local', frameUid: 1, slot: 1 }, value: 2 },
      { e: 'alloc', time: 4, id: 2, type: 'closure' },
      { e: 'alloc', time: 4, id: 3, type: 'cell' },
      {
        e: 'declare',
        time: 5,
        target: { kind: 'local', frameUid: 1, slot: 2 },
        value: expect.objectContaining({ id: 2 }),
      },
      { e: 'declare', time: 8, target: { kind: 'local', frameUid: 2, slot: 1 }, value: 9 },
      { e: 'write', time: 10, target: { kind: 'local', frameUid: 1, slot: 1 }, value: 9 },
      { e: 'output', time: 16, text: 'hi' },
      { e: 'declare', time: 19, target: { kind: 'global', name: 'g' }, value: 3 },
      { e: 'write', time: 21, target: { kind: 'global', name: 'g' }, value: 4 },
      { e: 'cellClosed', time: 22, cellId: 3, ownerFrameUid: 1, slot: 1 },
    ])
  })

  test('a closed cell is written as a cell target', () => {
    const text = `
Const 0
Closure set local 1
EndScope 1
Const 5
Call 1
Pop
Nil
Return
.fn set arity=1 upvalues=1
GetLocal 1
SetUpvalue 0
Nil
Return
.end`
    const writes = eventsOf(text).filter((event) => event.e === 'write')
    expect(writes).toEqual([{ e: 'write', time: 6, target: { kind: 'cell', cellId: 3 }, value: 5 }])
  })

  test('list operations report normalized indices', () => {
    const text = `
Const 1
Const 2
List 2
Declare 1
GetLocal 1
Const 3
ListAppend
Const "ab"
ListExtend
Pop
GetBuiltin insert
GetLocal 1
Const -1
Const 9
Call 3
Pop
GetBuiltin remove
GetLocal 1
Const -2
Call 2
Pop
GetBuiltin pop
GetLocal 1
Call 1
Pop
GetBuiltin push
GetLocal 1
Nil
Call 2
Pop
GetLocal 1
Const -1
Const 0
SetIndex
Nil
Return`
    const listEvents = eventsOf(text).filter((event) => event.e === 'listOp' || event.e === 'write')
    expect(listEvents).toEqual([
      { e: 'listOp', time: 6, listId: 2, op: 'append', index: 2, count: 1, value: 3 },
      { e: 'listOp', time: 8, listId: 2, op: 'extend', index: 3, count: 2, value: 'ab' },
      { e: 'listOp', time: 14, listId: 2, op: 'insert', index: 4, count: 1, value: 9 },
      { e: 'listOp', time: 19, listId: 2, op: 'remove', index: 4, count: 1, value: 9 },
      { e: 'listOp', time: 23, listId: 2, op: 'pop', index: 4, count: 1, value: 'b' },
      { e: 'listOp', time: 28, listId: 2, op: 'append', index: 4, count: 1, value: null },
      { e: 'write', time: 33, target: { kind: 'element', objectId: 2, index: 4 }, value: 0 },
    ])
  })

  test('record writes, merges and deletes', () => {
    const text = `
Const "a"
Const 1
Record 1
Const "b"
Const 2
RecordSet
Const "a"
Const 3
Const "c"
Const 4
Record 2
RecordMerge
Declare 1
GetLocal 1
Const 5
SetField d
GetLocal 1
Const "e"
Const 6
SetIndex
GetBuiltin delete
GetLocal 1
Const "a"
Call 2
Pop
GetBuiltin delete
GetLocal 1
Const "zz"
Call 2
Pop
Nil
Return`
    const events = eventsOf(text).filter((event) => event.e !== 'declare' && event.e !== 'alloc')
    const field = (objectId: number, key: string) => ({ kind: 'field', objectId, key })
    expect(events).toEqual([
      { e: 'write', time: 5, target: field(2, 'b'), value: 2 },
      { e: 'write', time: 11, target: field(2, 'a'), value: 3 },
      { e: 'write', time: 11, target: field(2, 'c'), value: 4 },
      { e: 'write', time: 15, target: field(2, 'd'), value: 5 },
      { e: 'write', time: 19, target: field(2, 'e'), value: 6 },
      { e: 'fieldDelete', time: 23, recordId: 2, key: 'a' },
    ])
  })

  test('every allocation is reported, including iterators, ranges and rest lists', () => {
    const text = `
Const 0
Const 2
Range 0
IterInit
@next: IterNext @done
Pop
Jump @next
@done: Pop
Const 1
Const 2
List 2
Destructure {"t":"list","before":[],"rest":"bind","after":[]}
Pop
GetBuiltin keys
Record 0
Call 1
Pop
Nil
Return`
    const allocs = eventsOf(text).filter((event) => event.e === 'alloc')
    expect(
      allocs.map((event) => (event.e === 'alloc' ? [event.time, event.id, event.type] : [])),
    ).toEqual([
      [2, 2, 'range'],
      [3, 3, 'iterator'],
      [14, 4, 'list'],
      [15, 5, 'list'],
      [18, 6, 'record'],
      [19, 7, 'list'],
    ])
  })

  test('hooks are pure observers: the state is identical with hooks on or off', () => {
    const steps = 40
    const withHooks = startAsm(CELLS)
    const without = startAsm(CELLS, { hooks: false })
    for (let t = 0; t < steps; t++) {
      expect(digest(withHooks.vm)).toBe(digest(without.vm))
      if (withHooks.vm.status !== 'running') break
      withHooks.vm.step()
      without.vm.step()
    }
    expect(withHooks.vm.status).toBe('finished')
  })
})
