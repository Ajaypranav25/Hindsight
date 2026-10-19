/**
 * Test helpers for the VM and natives: run assembled programs with every hook recorded, and call a
 * single native the way the VM does (arity check included).
 */
import type { RuntimeErrorInfo, WriteTarget, ListOp } from '../api-types'
import { LIBRARY_COUNT, builtinIndex } from '../builtin-names'
import type { Program } from '../bytecode'
import { createNatives } from '../natives'
import type { HeapObject, Value, VM, VMHooks } from '../runtime-types'
import { createVM } from '../vm'
import { callNonClosure } from '../vm-calls'
import { VMFailure } from '../vm-errors'
import { MachineState } from '../vm-state'
import { type AssembleOptions, assemble } from './assembler'

/** Natives followed by empty library slots, in BUILTIN_NAMES order. */
export function testBuiltins(): Value[] {
  return [...createNatives(), ...new Array<Value>(LIBRARY_COUNT).fill(null)]
}

export type HookEvent =
  | { readonly e: 'output'; readonly time: number; readonly text: string }
  | {
      readonly e: 'declare' | 'write'
      readonly time: number
      readonly target: WriteTarget
      readonly value: Value
    }
  | {
      readonly e: 'listOp'
      readonly time: number
      readonly listId: number
      readonly op: ListOp
      readonly index: number
      readonly count: number
      readonly value: Value
    }
  | {
      readonly e: 'fieldDelete'
      readonly time: number
      readonly recordId: number
      readonly key: string
    }
  | { readonly e: 'alloc'; readonly time: number; readonly id: number; readonly type: string }
  | {
      readonly e: 'cellClosed'
      readonly time: number
      readonly cellId: number
      readonly ownerFrameUid: number
      readonly slot: number
    }

/** Hooks that append every event to `events`. */
export function recordingHooks(events: HookEvent[]): VMHooks {
  return {
    output: (time, text) => events.push({ e: 'output', time, text }),
    write: (time, kind, target, value) => events.push({ e: kind, time, target, value }),
    listOp: (time, listId, op, index, count, value) =>
      events.push({ e: 'listOp', time, listId, op, index, count, value }),
    fieldDelete: (time, recordId, key) => events.push({ e: 'fieldDelete', time, recordId, key }),
    alloc: (time, object: HeapObject) =>
      events.push({ e: 'alloc', time, id: object.id, type: object.type }),
    cellClosed: (time, cellId, ownerFrameUid, slot) =>
      events.push({ e: 'cellClosed', time, cellId, ownerFrameUid, slot }),
  }
}

export interface RunOutcome {
  readonly vm: VM
  readonly program: Program
  readonly events: HookEvent[]
  readonly outputs: string[]
  readonly error: RuntimeErrorInfo | null
}

export interface RunAsmOptions extends AssembleOptions {
  readonly seed?: number
  readonly maxSteps?: number
  /** Default true. */
  readonly hooks?: boolean
}

export function startAsm(text: string, options: RunAsmOptions = {}): RunOutcome {
  const program = assemble(text, options)
  const vm = createVM(program, { builtins: testBuiltins(), libraryProtos: [], seed: options.seed })
  const events: HookEvent[] = []
  if (options.hooks !== false) vm.hooks = recordingHooks(events)
  return { vm, program, events, outputs: [], error: null }
}

/** Assembles and runs `text` to completion (or `maxSteps`). */
export function runAsm(text: string, options: RunAsmOptions = {}): RunOutcome {
  const started = startAsm(text, options)
  started.vm.runUntil(options.maxSteps ?? 1_000_000)
  return finishRun(started)
}

function finishRun(run: RunOutcome): RunOutcome {
  const outputs = run.events.flatMap((event) => (event.e === 'output' ? [event.text] : []))
  return { ...run, outputs, error: run.vm.error }
}

/** The value left by a script that ends `…; Return` is not observable, so tests print instead. */
export function printed(text: string, options: RunAsmOptions = {}): string[] {
  const run = runAsm(text, options)
  if (run.error !== null) throw new Error(`unexpected ${run.error.code}: ${run.error.message}`)
  return run.outputs
}

export type NativeResult =
  | { readonly ok: true; readonly value: Value; readonly machine: MachineState }
  | {
      readonly ok: false
      readonly code: string
      readonly message: string
      readonly hint: string | undefined
    }

const EMPTY_PROGRAM_TEXT = 'Nil\nReturn'

/** Calls the native `name` with `args` exactly as `Call argc` would (arity checked first). */
export function callNative(name: string, ...args: Value[]): NativeResult {
  const machine = nativeMachine()
  return callNativeOn(machine, name, ...args)
}

export function nativeMachine(seed?: number): MachineState {
  const program = assemble(EMPTY_PROGRAM_TEXT)
  return new MachineState(program, { builtins: testBuiltins(), libraryProtos: [], seed })
}

export function callNativeOn(machine: MachineState, name: string, ...args: Value[]): NativeResult {
  const native = machine.builtins[builtinIndex(name)] as Value
  const calleeIndex = machine.stack.length
  machine.stack.push(native, ...args)
  try {
    callNonClosure(machine, native, calleeIndex, args.length)
    return { ok: true, value: machine.stack.pop() as Value, machine }
  } catch (caught) {
    if (!(caught instanceof VMFailure)) throw caught
    machine.stack.length = calleeIndex
    return { ok: false, code: caught.code, message: caught.message, hint: caught.hint }
  }
}
