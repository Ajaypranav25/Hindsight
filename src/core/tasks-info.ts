/**
 * Read-only views of a VM's tasks for outcomes and tools (SPEC §10.6, ARCHITECTURE §6.11).
 */
import {
  DEFAULT_QUANTUM,
  DEFAULT_SCHEDULE_SEED,
  type Outcome,
  type ScheduleOptions,
  type TaskWaitView,
  type UnfinishedTask,
} from './api-types'
import type { Task, TaskWait, VM } from './runtime-types'

export function taskWaitView(wait: TaskWait | null): TaskWaitView | null {
  if (wait === null) return null
  return wait.kind === 'join'
    ? { kind: 'join', task: wait.task }
    : { kind: wait.kind, channelId: wait.channel.id }
}

/** The tasks other than the main one that had not finished, in id order. */
export function unfinishedTasks(tasks: readonly Readonly<Task>[] | null): UnfinishedTask[] {
  const out: UnfinishedTask[] = []
  for (const task of tasks ?? []) {
    if (task.status === 'done') continue
    out.push({
      id: task.id,
      name: task.name,
      status: task.status,
      wait: taskWaitView(task.wait),
    })
  }
  return out
}

/** The largest quantum tools accept (a larger one is never preempted in practice). */
export const MAX_QUANTUM = 1_000_000

/**
 * A schedule in its canonical form: undefined for round-robin (the default), else the random
 * policy with its quantum and seed spelled out, so equal schedules compare and serialize equal.
 */
export function normalSchedule(schedule: ScheduleOptions | undefined): ScheduleOptions | undefined {
  if (schedule === undefined || schedule.policy !== 'random') return undefined
  return {
    policy: 'random',
    quantum: Math.max(1, Math.floor(schedule.quantum ?? DEFAULT_QUANTUM)),
    seed: (schedule.seed ?? DEFAULT_SCHEDULE_SEED) >>> 0,
  }
}

/** `{kind: 'finished'}`, listing the tasks the main task left unfinished when there are any. */
export function finishedOutcome(vm: VM): Outcome {
  const unfinished = unfinishedTasks(vm.tasks)
  return unfinished.length === 0
    ? { kind: 'finished' }
    : { kind: 'finished', unfinishedTasks: unfinished }
}
