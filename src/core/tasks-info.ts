/**
 * Read-only views of a VM's tasks for outcomes and tools (SPEC §10.6, ARCHITECTURE §6.11).
 */
import type { Outcome, TaskWaitView, UnfinishedTask } from './api-types'
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

/** `{kind: 'finished'}`, listing the tasks the main task left unfinished when there are any. */
export function finishedOutcome(vm: VM): Outcome {
  const unfinished = unfinishedTasks(vm.tasks)
  return unfinished.length === 0
    ? { kind: 'finished' }
    : { kind: 'finished', unfinishedTasks: unfinished }
}
