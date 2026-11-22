/**
 * What a task native asks of the step loop (vm-tasks.ts), in `MachineState.request`. A module of
 * its own so the machine state, the call path and the task module share it without import cycles.
 */
export const Request = {
  none: 0,
  /** The running task blocked: its ip goes back to the `Call`, and another task runs. */
  block: 1,
  /** `yield()`: another runnable task, if any, runs after this step. */
  yield: 2,
  /** The running task finished: another task runs. */
  done: 3,
  /**
   * No switch, but the slice ends: the first spawn under the random policy just set the first
   * preemption point, which the running slice's limit does not know.
   */
  reslice: 4,
} as const
