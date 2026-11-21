/**
 * VM and recorder benchmarks (ARCHITECTURE §6.10): prints timings, snapshot counts and retained
 * snapshot values for a set of representative programs. Run with
 *
 *   node --expose-gc --import tsx scripts/bench-vm.ts [name…]
 *
 * Numbers are wall-clock medians of a few runs on this machine; compare runs made back to back.
 */
import { compile, record, run } from '../src/core/index'
import type { Program, Recording } from '../src/core/index'
import { replayAccess } from '../src/core/recorder'
import { startAsm } from '../src/core/testing/vm-harness'

const gc = (globalThis as { gc?: () => void }).gc

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function timed<T>(body: () => T): { value: T; ms: number } {
  const started = performance.now()
  const value = body()
  return { value, ms: performance.now() - started }
}

function compiled(source: string): Program {
  const result = compile(source)
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.program
}

function heapMb(): number {
  gc?.()
  return process.memoryUsage().heapUsed / 1e6
}

/** A deterministic pseudo-random sequence of times in `0..=n`. */
function seekTimes(n: number, count: number): number[] {
  let state = 12345
  return Array.from({ length: count }, () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % (n + 1)
  })
}

function averageSeekMs(recording: Recording, count: number): number {
  const times = seekTimes(recording.length, count)
  const started = performance.now()
  for (const t of times) recording.stateAt(t)
  return (performance.now() - started) / count
}

/** Single steps backwards at `count` evenly spaced times, each from a fresh replay position. */
function stepBackMs(recording: Recording, count: number): { max: number; avg: number } {
  const access = replayAccess(recording)!
  const timesMs: number[] = []
  for (let i = 0; i < count; i++) {
    const t = 1 + Math.floor(((recording.length - 1) * (i + 1)) / count)
    const seeker = access.newSeeker()
    seeker.positionAt(t)
    timesMs.push(timed(() => seeker.positionAt(t - 1)).ms)
  }
  return { max: Math.max(...timesMs), avg: timesMs.reduce((a, b) => a + b, 0) / count }
}

function snapshotStats(recording: Recording): string {
  const schedule = replayAccess(recording)!.core.schedule
  const entries = schedule.list
  const sizes = entries.reduce((sum, entry) => sum + entry.size, 0)
  const retained = (schedule as unknown as { retainedValues?: number }).retainedValues ?? sizes
  return `${entries.length} snapshots, retained ${retained.toLocaleString('en-US')} values, interval ${schedule.currentInterval}`
}

function benchRecording(name: string, source: string, seeks: number, backSteps = 0): void {
  const program = compiled(source)
  const before = heapMb()
  const runs: number[] = []
  // The previous recording is released before each run, so memory is measured for one recording.
  const held: { recording: Recording | null } = { recording: null }
  for (let i = 0; i < 3; i++) {
    held.recording = null
    gc?.()
    const result = timed(() => record(program, { maxSteps: 50_000_000 }))
    held.recording = result.value
    runs.push(result.ms)
  }
  const kept = held.recording!
  const memory = heapMb() - before
  const seek = averageSeekMs(kept, seeks)
  const back = backSteps > 0 ? stepBackMs(kept, backSteps) : null
  console.log(
    `${name}: ${kept.length.toLocaleString('en-US')} steps, record ${median(runs).toFixed(0)} ms, ` +
      `seek ${seek.toFixed(2)} ms avg, ${snapshotStats(kept)}, heap +${memory.toFixed(0)} MB` +
      (back === null ? '' : `, step back max ${back.max.toFixed(1)} ms avg ${back.avg.toFixed(1)}`),
  )
}

const COUNTING_LOOP = `
Const 0
Declare 1
@loop: GetLocal 1
Const 555555
Lt
JumpIfFalse @end
GetLocal 1
Const 1
Add
SetLocal 1
Jump @loop
@end: Nil
Return`

function benchVM(): void {
  const runs: number[] = []
  const steps: number[] = []
  for (let i = 0; i < 5; i++) {
    const a = startAsm(COUNTING_LOOP, { hooks: false })
    runs.push(timed(() => a.vm.runUntil(Infinity)).ms)
    const b = startAsm(COUNTING_LOOP, { hooks: false })
    steps.push(
      timed(() => {
        while (b.vm.status === 'running') b.vm.step()
      }).ms,
    )
  }
  console.log(
    `vm: 5M-instruction loop runUntil ${median(runs).toFixed(0)} ms, step() ${median(steps).toFixed(0)} ms`,
  )
}

function benchRun(name: string, source: string): void {
  const program = compiled(source)
  const runs: number[] = []
  let steps = 0
  for (let i = 0; i < 5; i++) {
    const result = timed(() => run(program, { maxSteps: 50_000_000 }))
    steps = result.value.steps
    runs.push(result.ms)
  }
  console.log(
    `run ${name}: ${steps.toLocaleString('en-US')} steps in ${median(runs).toFixed(0)} ms`,
  )
}

const LOOP_HEAVY = `fn step(x) { x + 1 }
var total = 0
var i = 0
while i < 50000 {
  total = total + step(i) % 7
  i += 1
}
print(total)`

const HEAP_HEAVY = `var rs = []
for i in 0..60000 {
  push(rs, {id: i, name: "n" + str(i)})
}
print(len(rs))`

/** A 50,000-element list mutated in place at scattered positions, about 2,000,000 steps. */
const MUTATE_LIST = `var xs = []
for i in 0..50000 { push(xs, i) }
var k = 0
while k < 100000 {
  let j = k * 7919 % 50000
  xs[j] = xs[j] + 1
  k += 1
}
print(xs[0])`

/** A 50,000-field record used as a dictionary, about 2,000,000 steps. */
const MUTATE_RECORD = `var r = {}
for i in 0..50000 { r["k" + str(i)] = i }
var k = 0
while k < 70000 {
  let key = "k" + str(k * 7919 % 50000)
  r[key] = r[key] + 1
  k += 1
}
print(r.k0)`

/** Heavy natives inside loops: each such step sorts, copies or scans a whole 100,000-item list. */
const HEAVY_NATIVES = `var xs = []
for i in 0..100000 { push(xs, i * 7919 % 100003) }
var total = 0
for round in 0..60 {
  let s = sort(xs)
  total += s[round] + len(slice(xs, round)) + index_of(xs, -1)
}
for round in 0..2 {
  let evens = filter(xs, |x| x % 2 == round)
  total += len(map(evens, |x| x * 2))
}
print(total)`

const BENCHES: Record<string, () => void> = {
  vm: benchVM,
  run: () => {
    benchRun('loop-heavy', LOOP_HEAVY)
    benchRun('mutate-list', MUTATE_LIST)
    benchRun('heavy-natives', HEAVY_NATIVES)
  },
  loop: () => benchRecording('record loop-heavy', LOOP_HEAVY, 200),
  heap: () => benchRecording('record heap-heavy', HEAP_HEAVY, 20),
  list: () => benchRecording('record mutate-list', MUTATE_LIST, 200),
  record: () => benchRecording('record mutate-record', MUTATE_RECORD, 200),
  natives: () => benchRecording('record heavy-natives', HEAVY_NATIVES, 50, 40),
}

const selected = process.argv.slice(2)
for (const [name, bench] of Object.entries(BENCHES)) {
  if (selected.length === 0 || selected.includes(name)) bench()
}
