/**
 * Test helpers for programs with tasks (SPEC §10.6): compile with the library and create VMs under
 * a schedule, plus a few programs that exercise every task feature.
 */
import type { ScheduleOptions } from '../api-types'
import type { Program } from '../bytecode'
import { compile } from '../index'
import { getLibrary } from '../library'
import type { RuntimeDeps, VM } from '../runtime-types'
import { createVM } from '../vm'

export function compileTasks(source: string): Program {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return result.program
}

export function libraryRuntime(): RuntimeDeps {
  const library = getLibrary()
  return { createVM, builtins: library.builtins, libraryProtos: library.protos }
}

export function tasksVM(program: Program, schedule?: ScheduleOptions, seed?: number): VM {
  const library = getLibrary()
  return createVM(program, {
    builtins: library.builtins,
    libraryProtos: library.protos,
    seed,
    schedule,
  })
}

/** Two tasks increment a shared global without synchronizing: updates get lost under preemption. */
export const BANK_RACE = `
var balance = 0
fn deposit(n) {
  for i in 0..n {
    let b = balance
    balance = b + 1
  }
}
let a = spawn(deposit, 30)
let b = spawn(deposit, 30)
wait(a)
wait(b)
print(balance)
`

/**
 * Workers over buffered and unbuffered channels, a closing feeder, a closure shared with another
 * task (an open cell of a running frame), joins and yields.
 */
export const PIPELINE = `
let jobs = channel(2)
let results = channel()
fn worker(id) {
  var job = recv(jobs)
  while job != nil {
    send(results, [id, job * job])
    job = recv(jobs)
  }
  return id
}
fn feed() {
  for i in 1..=6 {
    send(jobs, i)
    yield()
  }
  close(jobs)
}
fn main() {
  var seen = 0
  let w1 = spawn(worker, 1)
  let w2 = spawn(worker, 2)
  spawn(feed)
  let bump = spawn(fn(k) { seen = seen + k }, 100)
  for i in 0..6 {
    let pair = recv(results)
    seen = seen + pair[1]
  }
  wait(bump)
  print(seen, wait(w1) + wait(w2), random_int(1, 9))
}
main()
`
