/**
 * Test-only factories for runtime values (lists, records, ranges, functions) that do not need a VM.
 * Ids come from a module-level counter starting at 1000 unless given explicitly.
 */
import type { FunctionProto } from '../bytecode'
import type {
  ClosureObj,
  ListObj,
  NativeFn,
  NativeObj,
  RangeObj,
  RecordObj,
  Value,
} from '../runtime-types'

let nextFixtureId = 1000

function freshId(): number {
  return nextFixtureId++
}

export interface FixtureProtoOptions {
  readonly id?: number
  readonly arity?: number
  readonly library?: boolean
}

/** A code-less FunctionProto, enough for display names and type checks. */
export function fixtureProto(
  name: string | null,
  options: FixtureProtoOptions = {},
): FunctionProto {
  const library = options.library ?? false
  return {
    tag: 'proto',
    id: options.id ?? 0,
    name,
    kind: 'function',
    arity: options.arity ?? 0,
    code: [],
    constants: [],
    upvalueCount: 0,
    debug: {
      source: library ? 'prelude' : 'main',
      library,
      span: { start: 0, end: 0 },
      spanStart: new Int32Array(0),
      spanEnd: new Int32Array(0),
      stmtStart: new Uint8Array(0),
      stmtSpanStart: new Int32Array(0),
      stmtSpanEnd: new Int32Array(0),
      locals: [],
      upvalueNames: [],
    },
  }
}

export function makeList(...items: Value[]): ListObj {
  return { type: 'list', id: freshId(), items }
}

export function makeRecord(
  entries: Readonly<Record<string, Value>> | [string, Value][],
): RecordObj {
  const pairs = Array.isArray(entries) ? entries : Object.entries(entries)
  return { type: 'record', id: freshId(), fields: new Map(pairs) }
}

export function makeRange(start: number, end: number, step = 1, inclusive = false): RangeObj {
  return { type: 'range', id: freshId(), start, end, step, inclusive }
}

/** A closure over a code-less proto. A negative id makes it a library builtin. */
export function makeClosure(name: string | null, id: number = freshId()): ClosureObj {
  return { type: 'closure', id, proto: fixtureProto(name, { library: id < 0 }), upvalues: [] }
}

export function makeNative(name: string, id = -1, fn: NativeFn = () => null): NativeObj {
  return { type: 'native', id, name, minArgs: 0, maxArgs: Infinity, fn }
}

/** A list nested `depth` levels deep: `[[[...[]...]]]` (depth 1 is `[]`). Built iteratively. */
export function deepList(depth: number, innermost: Value[] = []): ListObj {
  let current = makeList(...innermost)
  for (let level = 1; level < depth; level++) current = makeList(current)
  return current
}
