/**
 * Dynamic opcode statistics over the conformance corpus (tests/lang) and the gallery (examples/):
 * how often each instruction, each pair and each triple of consecutive instructions in the same
 * frame executes. Used to pick fused-dispatch candidates for vm-exec.ts (ARCHITECTURE §6.10).
 * By default every program weighs the same (its counts are divided by its own instruction count),
 * so a few stress tests that run 100,000-iteration loops do not drown out the rest; `--raw` weighs
 * programs by the instructions they execute instead, which favors hot loops.
 *
 *   npx tsx scripts/opcode-pairs.ts [--top N] [--raw]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '../src/core/index'
import { OP_NAMES } from '../src/core/bytecode'
import { getLibrary } from '../src/core/library'
import { createVM } from '../src/core/vm'

const MAX_STEPS = 5_000_000

function sightFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...sightFiles(path))
    else if (name.endsWith('.sight')) found.push(path)
  }
  return found
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

const singles = new Map<string, number>()
const pairs = new Map<string, number>()
const triples = new Map<string, number>()
let total = 0
let programs = 0

const raw = process.argv.includes('--raw')

/** Adds one program's counts to the shares (divided by its instruction count unless `--raw`). */
function merge(into: Map<string, number>, counts: Map<string, number>, executed: number): void {
  const weight = raw ? 1 : 1 / executed
  for (const [key, count] of counts) into.set(key, (into.get(key) ?? 0) + count * weight)
}

function profile(source: string): void {
  const result = compile(source)
  if (!result.ok) return
  const library = getLibrary()
  const vm = createVM(result.program, { builtins: library.builtins, libraryProtos: library.protos })
  const ones = new Map<string, number>()
  const twos = new Map<string, number>()
  const threes = new Map<string, number>()
  let previous = ''
  let previous2 = ''
  let previousFrame = -1
  while (vm.status === 'running' && vm.time < MAX_STEPS) {
    const frame = vm.frames[vm.frames.length - 1]!
    const name = OP_NAMES[frame.closure.proto.code[frame.ip]!]!
    bump(ones, name)
    if (frame.uid === previousFrame) {
      bump(twos, `${previous} ${name}`)
      if (previous2 !== '') bump(threes, `${previous2} ${previous} ${name}`)
      previous2 = previous
    } else {
      previous2 = ''
    }
    previous = name
    previousFrame = frame.uid
    vm.step()
  }
  if (vm.time === 0) return
  total += vm.time
  programs++
  merge(singles, ones, vm.time)
  merge(pairs, twos, vm.time)
  merge(triples, threes, vm.time)
}

function report(title: string, counts: Map<string, number>, top: number): void {
  console.log(`\n${title}`)
  const sorted = [...counts].sort((a, b) => b[1] - a[1]).slice(0, top)
  for (const [key, share] of sorted) {
    console.log(`${((100 * share) / (raw ? total : programs)).toFixed(2).padStart(6)}%  ${key}`)
  }
}

const topIndex = process.argv.indexOf('--top')
const top = topIndex >= 0 ? Number(process.argv[topIndex + 1]) : 25
const files = [...sightFiles('tests/lang'), ...sightFiles('examples')]
for (const file of files) profile(readFileSync(file, 'utf8'))
console.log(`${programs} programs ran, ${total.toLocaleString('en-US')} instructions executed`)
report('instructions', singles, top)
report('pairs (same frame)', pairs, top)
report('triples (same frame)', triples, top)
