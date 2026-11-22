/**
 * Tasks and channels (SPEC §10.6, ARCHITECTURE §6.11): deterministic cooperative tasks on one VM.
 *
 * Each task owns a stack, frames and open cells; the machine's `stack`, `frames` and `openCells` are
 * the running task's arrays, so the step loop needs no per-instruction task checks. Natives reach
 * this module through `NativeContext.tasks` and never call user code: `spawn` prepares the new
 * task's first frame, and an operation that must wait marks the running task blocked and leaves a
 * request (`Request`) that the step loop handles after the native returns, at the end of the step.
 *
 * A blocked task stands on its `Call` with the callee and arguments still on its stack. The task
 * that unblocks it completes the call on its behalf (replaces callee and arguments with the result
 * and moves its ip past the `Call`), so every blocking call costs exactly one step and completes
 * exactly once. Senders blocked on a channel that gets closed instead retry their `Call` (and then
 * fail with R029). Waiters are served in the order they blocked.
 *
 * Switch points are blocking, `yield()`, a task's completion and, under the random policy,
 * preemption. Every decision happens at the end of a step, so the state at a time already shows
 * the task that executes the next step, whichever way the time was reached.
 */
import { Op, functionDisplayName } from './bytecode'
import { InternalError } from './diagnostics'
import type {
  ChannelObj,
  ClosureObj,
  Frame,
  Task,
  TaskObj,
  TaskOps,
  TaskWait,
  Value,
} from './runtime-types'
import { LineIndex } from './span'
import { closureArityMessage } from './vm-calls'
import { raise, spanAt } from './vm-errors'
import { Request } from './vm-request'
import type { MachineState } from './vm-state'

/** The main script's task number. */
export const MAIN_TASK = 1
/** At most this many tasks may be unfinished at once (R030). */
export const MAX_LIVE_TASKS = 10_000

export const DEADLOCK_MESSAGE = 'deadlock: every task is waiting'

/** The task operations natives use (`NativeContext.tasks`). */
export class MachineTasks implements TaskOps {
  constructor(private readonly m: MachineState) {}

  spawn(fn: ClosureObj, args: readonly Value[]): TaskObj {
    return spawnTask(this.m, fn, args)
  }

  channel(capacity: number): ChannelObj {
    return this.m.newChannel(capacity)
  }

  send(channel: ChannelObj, value: Value): void {
    sendValue(this.m, channel, value)
  }

  recv(channel: ChannelObj): Value {
    return receiveValue(this.m, channel)
  }

  close(channel: ChannelObj): void {
    closeChannel(this.m, channel)
  }

  wait(task: TaskObj): Value {
    return waitFor(this.m, task)
  }

  yieldTask(): void {
    if (this.m.tasks !== null) this.m.request = Request.yield
  }

  current(): TaskObj {
    const m = this.m
    ensureTasks(m)
    const current = m.current!
    current.object ??= m.newTaskObject(current.id, current.name)
    return current.object
  }
}

/** Turns on task bookkeeping: the main script becomes task 1, running. */
function ensureTasks(m: MachineState): Task[] {
  if (m.tasks !== null) return m.tasks
  const main: Task = {
    id: MAIN_TASK,
    name: 'main',
    stack: m.stack,
    frames: m.frames,
    openCells: m.openCells,
    status: 'runnable',
    wait: null,
    since: 0,
    result: null,
    object: null,
  }
  m.tasks = [main]
  m.current = main
  m.liveTasks = 1
  return m.tasks
}

function spawnTask(m: MachineState, fn: ClosureObj, args: readonly Value[]): TaskObj {
  if (m.liveTasks >= MAX_LIVE_TASKS) {
    raise('R030', `too many tasks: more than ${MAX_LIVE_TASKS} are unfinished`)
  }
  if (fn.proto.arity !== args.length) raise('R005', closureArityMessage(fn.proto, args.length))
  const tasks = ensureTasks(m)
  const id = tasks.length + 1
  const name = functionDisplayName(fn.proto)
  const object = m.newTaskObject(id, name)
  const frame: Frame = { closure: fn, ip: 0, base: 0, uid: m.nextFrameUid++ }
  tasks.push({
    id,
    name,
    stack: [fn, ...args],
    frames: [frame],
    openCells: [],
    status: 'runnable',
    wait: null,
    since: 0,
    result: null,
    object,
  })
  m.liveTasks++
  for (let slot = 1; slot <= args.length; slot++) {
    m.recordLocal('declare', frame.uid, slot, args[slot - 1] as Value)
  }
  // The first preemption is drawn once a second task exists; it takes effect after this step, and
  // the running slice must end to see it.
  if (m.policy === 'random' && m.preemptAt === Infinity) {
    newQuantum(m, m.time + 1)
    m.request = Request.reslice
  }
  return object
}

function sendValue(m: MachineState, channel: ChannelObj, value: Value): void {
  if (channel.closed) raise('R029', 'cannot send on a closed channel')
  const receiver = firstWaiter(m, 'recv', channel)
  // A waiting receiver means the buffer is empty: hand the value over directly.
  if (receiver !== null) completeCall(receiver, value)
  else if (channel.items.length < channel.capacity) {
    m.noteObject(channel)
    channel.items.push(value)
  } else block(m, { kind: 'send', channel })
}

function receiveValue(m: MachineState, channel: ChannelObj): Value {
  if (channel.items.length > 0) {
    m.noteObject(channel)
    const value = channel.items.shift() as Value
    // A sender waiting on a full buffer moves its value into the freed place.
    const sender = firstWaiter(m, 'send', channel)
    if (sender !== null) {
      channel.items.push(sentValue(sender))
      completeCall(sender, null)
    }
    return value
  }
  const sender = firstWaiter(m, 'send', channel)
  if (sender !== null) {
    const value = sentValue(sender)
    completeCall(sender, null)
    return value
  }
  if (channel.closed) return null
  block(m, { kind: 'recv', channel })
  return null
}

function closeChannel(m: MachineState, channel: ChannelObj): void {
  if (channel.closed) raise('R029', 'channel is already closed')
  m.noteObject(channel)
  channel.closed = true
  if (m.tasks === null) return
  for (const task of waitersInOrder(m.tasks, channel)) {
    // Receivers get nil; senders retry their call, which now fails.
    if (task.wait!.kind === 'recv') completeCall(task, null)
    else wake(task)
  }
}

function waitFor(m: MachineState, handle: TaskObj): Value {
  const target = m.tasks?.[handle.task - 1]
  if (target === undefined) throw new InternalError(`no task ${handle.task}`)
  if (target === m.current) raise('R019', "'wait' cannot wait for the task that calls it")
  if (target.status === 'done') return target.result
  block(m, { kind: 'join', task: target.id })
  return null
}

/** Marks the running task blocked (R028 when no other task could run) and requests a switch. */
function block(m: MachineState, wait: TaskWait): void {
  const tasks = m.tasks
  const current = m.current
  if (tasks === null || current === null || !tasks.some((t) => t !== current && isRunnable(t))) {
    raise('R028', DEADLOCK_MESSAGE, deadlockHint(m, wait))
  }
  current.status = 'blocked'
  current.wait = wait
  current.since = m.time
  m.request = Request.block
}

function isRunnable(task: Task): boolean {
  return task.status === 'runnable'
}

/** The task blocked longest on `kind` for `channel`, or null. */
function firstWaiter(m: MachineState, kind: 'send' | 'recv', channel: ChannelObj): Task | null {
  const tasks = m.tasks
  if (tasks === null) return null
  let first: Task | null = null
  for (const task of tasks) {
    const wait = task.wait
    if (wait === null || wait.kind !== kind || wait.channel !== channel) continue
    if (first === null || task.since < first.since) first = task
  }
  return first
}

/** Every task blocked on `channel`, in the order they blocked. */
function waitersInOrder(tasks: readonly Task[], channel: ChannelObj): Task[] {
  return tasks
    .filter(
      (task) => task.wait !== null && task.wait.kind !== 'join' && task.wait.channel === channel,
    )
    .sort((a, b) => a.since - b.since)
}

/** The value a blocked `send(ch, v)` holds: the top of its stack. */
function sentValue(sender: Task): Value {
  return sender.stack[sender.stack.length - 1] as Value
}

/** Finishes a blocked task's `Call` with `result` and makes it runnable. */
function completeCall(task: Task, result: Value): void {
  const frame = task.frames[task.frames.length - 1]
  const code = frame?.closure.proto.code
  if (frame === undefined || code![frame.ip] !== Op.Call) {
    throw new InternalError(`task ${task.id} is not blocked on a call`)
  }
  const argc = code![frame.ip + 1]!
  const stack = task.stack
  stack.length -= argc + 1
  stack.push(result)
  frame.ip += 2
  wake(task)
}

/** Makes a blocked task runnable; it re-executes the `Call` it stands on. */
function wake(task: Task): void {
  task.status = 'runnable'
  task.wait = null
}

/**
 * The running task's function returned (its frame is already gone): the task is done, its waiters
 * get the result, and the step loop switches. When every remaining task is blocked, R028 reports at
 * this return.
 */
export function finishTask(m: MachineState, frame: Frame, result: Value): void {
  const tasks = m.tasks!
  const task = m.current!
  task.status = 'done'
  task.result = result
  m.liveTasks--
  for (const waiter of tasks.filter((t) => t.wait?.kind === 'join' && t.wait.task === task.id)) {
    completeCall(waiter, result)
  }
  if (!tasks.some(isRunnable)) {
    // The error reports at this return, with the task's frame back in place.
    task.frames.push(frame)
    raise('R028', DEADLOCK_MESSAGE, deadlockHint(m, null))
  }
  m.request = Request.done
}

/**
 * Handles the request a step left: after a block, a yield or a task's end, chooses the task to run
 * next (and, under the random policy, its quantum); a reslice needs nothing more.
 */
export function settleRequest(m: MachineState): void {
  const request = m.request
  m.request = Request.none
  if (request === Request.reslice) return
  const next = nextTask(m)
  if (next === null) {
    if (request !== Request.yield) throw new InternalError('no task can run after a switch')
  } else switchTo(m, next)
  if (m.policy === 'random') newQuantum(m, m.time)
}

/**
 * Random policy, at `preemptAt`: another runnable task, drawn at random, runs next (the same one
 * goes on when no other can), so a task runs at most `quantum` instructions while others wait.
 */
export function preempt(m: MachineState): void {
  if (m.tasks !== null) {
    const next = nextTask(m)
    if (next !== null) switchTo(m, next)
  }
  newQuantum(m, m.time)
}

/**
 * The task to run after the current one: round-robin takes the next runnable task in id order
 * (cyclically, the current one last); random draws among the other runnable tasks, falling back
 * to the current one.
 */
function nextTask(m: MachineState): Task | null {
  const tasks = m.tasks!
  const current = m.current!
  if (m.policy === 'random') {
    const others = tasks.filter((task) => task !== current && isRunnable(task))
    if (others.length > 0) return others[drawIndex(m, others.length)]!
    return isRunnable(current) ? current : null
  }
  const n = tasks.length
  const index = current.id - 1
  for (let i = 1; i <= n; i++) {
    const task = tasks[(index + i) % n]!
    if (isRunnable(task)) return task
  }
  return null
}

function switchTo(m: MachineState, task: Task): void {
  m.current = task
  m.stack = task.stack
  m.frames = task.frames
  m.openCells = task.openCells
}

function drawIndex(m: MachineState, count: number): number {
  return Math.floor(m.nextScheduleRandom() * count)
}

/** The next preemption: 1 to `quantum` instructions after `boundary`. */
function newQuantum(m: MachineState, boundary: number): void {
  m.preemptAt = boundary + 1 + drawIndex(m, m.quantum)
}

// ---------------------------------------------------------------------------------------------
// Deadlock hints

/** Describes a wait for messages: `waits to receive from channel #4`. */
export function describeWait(wait: TaskWait, tasks: readonly Task[] | null): string {
  switch (wait.kind) {
    case 'send':
      return `waits to send to channel #${wait.channel.id}`
    case 'recv':
      return `waits to receive from channel #${wait.channel.id}`
    case 'join': {
      const name = tasks?.[wait.task - 1]?.name
      return name === undefined
        ? `waits for task ${wait.task}`
        : `waits for task ${wait.task} (${name})`
    }
  }
}

/**
 * Every unfinished task and what it waits for: the running task (`wait`, about to block here; null
 * when it just finished) first, then the blocked ones in id order with the line of their call.
 */
function deadlockHint(m: MachineState, wait: TaskWait | null): string {
  const lines = new LineIndex(m.program.source)
  const parts: string[] = []
  const current = m.current
  if (wait !== null) {
    const id = current?.id ?? MAIN_TASK
    const name = current?.name ?? 'main'
    parts.push(`task ${id} (${name}) ${describeWait(wait, m.tasks)} here`)
  }
  for (const task of m.tasks ?? []) {
    if (task === current || task.wait === null) continue
    const line = waitLine(task, lines)
    const where = line === null ? '' : ` on line ${line}`
    parts.push(`task ${task.id} (${task.name}) ${describeWait(task.wait, m.tasks)}${where}`)
  }
  return parts.join('; ')
}

/** The line of the call a blocked task waits on, in its innermost user frame. */
function waitLine(task: Task, lines: LineIndex): number | null {
  const frames = task.frames
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]!
    const proto = frame.closure.proto
    if (proto.debug.library) continue
    const ip = i === frames.length - 1 ? frame.ip : frame.ip - 1
    return lines.lineOf(spanAt(proto, ip).start)
  }
  return null
}
