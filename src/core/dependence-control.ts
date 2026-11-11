/**
 * Static control dependence inside one function (ARCHITECTURE §7.8), read off the compiler's
 * emission recipes (§4.3.3): for every instruction, the conditional branch that decides whether it
 * runs, or -1.
 *
 * A branch at `j` with target `L` controls
 * - the code it falls into: `[j + length, L)`;
 * - the `else` part when the instruction before `L` is a forward `Jump E`: up to `E` (an `if`'s
 *   else block; the arms after a `match` arm);
 * - the loop condition when that instruction is a backward `Jump` (a `while` or `for`): the range
 *   starts at the loop's start, the branch itself included, so one iteration depends on the
 *   decision of the one before;
 * - and, when its range can leave early, whatever the exit skips: to the end of the function for
 *   a `return`, to the jump's target for a `break`, to the loop's exit for a `continue`.
 *
 * Where ranges overlap, the latest branch wins (the innermost one).
 */
import { type FunctionProto, instructionLength, Op } from './bytecode'

const NONE = -1
const tables = new WeakMap<FunctionProto, Int32Array>()

interface Region {
  readonly branch: number
  readonly start: number
  readonly end: number
}

/** Per code index: the ip of the branch the instruction is control-dependent on, or -1. */
export function controlParents(proto: FunctionProto): Int32Array {
  let table = tables.get(proto)
  if (table === undefined) {
    table = buildParents(proto)
    tables.set(proto, table)
  }
  return table
}

function branchTarget(code: readonly number[], ip: number): number {
  switch (code[ip]) {
    case Op.JumpIfFalse:
    case Op.AndJump:
    case Op.OrJump:
    case Op.IterNext:
      return code[ip + 1]!
    case Op.MatchPattern:
      return code[ip + 2]!
    default:
      return NONE
  }
}

function buildParents(proto: FunctionProto): Int32Array {
  const { code, constants } = proto
  const starts: number[] = []
  const previous = new Int32Array(code.length + 1).fill(NONE)
  for (let ip = 0, before = NONE; ip < code.length; ip += instructionLength(code, ip, constants)) {
    starts.push(ip)
    previous[ip] = before
    before = ip
  }
  previous[code.length] = starts.at(-1) ?? NONE

  const regions: Region[] = []
  for (const ip of starts) {
    const target = branchTarget(code, ip)
    if (target === NONE) continue
    let start = ip + instructionLength(code, ip, constants)
    let end = target
    const logical = code[ip] === Op.AndJump || code[ip] === Op.OrJump
    const before = previous[target] ?? NONE
    if (!logical && before !== NONE && before > ip && code[before] === Op.Jump) {
      const jump = code[before + 1]!
      if (jump > target) end = jump
      else if (jump <= ip) start = Math.min(start, jump)
    }
    regions.push({ branch: ip, start, end: logical ? end : withExits(proto, starts, start, end) })
  }

  const parents = new Int32Array(code.length).fill(NONE)
  for (const ip of starts) {
    let parent = NONE
    for (const region of regions) {
      if (ip >= region.start && ip < region.end && region.branch > parent) parent = region.branch
    }
    parents[ip] = parent
  }
  return parents
}

/** The end of a branch's range once early exits inside `[start, end)` are counted. */
function withExits(
  proto: FunctionProto,
  starts: readonly number[],
  start: number,
  end: number,
): number {
  const { code } = proto
  let reach = end
  for (const ip of starts) {
    if (ip < start || ip >= end) continue
    if (code[ip] === Op.Return) return code.length
    if (code[ip] !== Op.Jump) continue
    const target = code[ip + 1]!
    if (target > reach) reach = target
    else if (target < start) reach = Math.max(reach, loopExit(code, starts, target, end))
  }
  return reach
}

/** The exit of the loop that starts at `loopStart`: its first branch that jumps past `beyond`. */
function loopExit(
  code: readonly number[],
  starts: readonly number[],
  loopStart: number,
  beyond: number,
): number {
  for (const ip of starts) {
    if (ip < loopStart) continue
    if (code[ip] !== Op.JumpIfFalse && code[ip] !== Op.IterNext) continue
    const target = code[ip + 1]!
    if (target >= beyond) return target
  }
  return beyond
}
