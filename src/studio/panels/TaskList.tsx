/**
 * The tasks of a program at the pen (SPEC §10.6, ARCHITECTURE §11.3), under the call stack: each
 * task's number, name and status (running, ready, waiting for what, or done with its result), and
 * where each one that is not running stands (its frames, innermost first). The running task's
 * frames are the call stack above, whose frames can be selected.
 */
import { taskWaitText, type TaskView } from '../../core/index'
import { formatValue } from '../lib/format'
import './panels.css'

export function TaskList(props: {
  readonly tasks: readonly TaskView[]
  readonly justMyCode: boolean
}) {
  const { tasks, justMyCode } = props
  const names = new Map(tasks.map((task) => [task.id, task.name]))
  return (
    <section className="pn-tasks" aria-label="Tasks">
      <h3 className="pn-tasks-title pn-label">Tasks</h3>
      <ol className="pn-stack">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            status={statusText(task, (id) => names.get(id))}
            justMyCode={justMyCode}
          />
        ))}
      </ol>
    </section>
  )
}

function TaskRow(props: {
  readonly task: TaskView
  readonly status: string
  readonly justMyCode: boolean
}) {
  const { task, status, justMyCode } = props
  const frames = [...task.frames]
    .reverse()
    .filter((frame) => !justMyCode || !frame.library || frame === task.frames.at(-1))
  const showFrames = !task.current && task.status !== 'done'
  return (
    <li
      className={`pn-task pn-task--${task.current && task.status !== 'done' ? 'running' : task.status}`}
    >
      <div className="pn-frame pn-frame--static">
        <span className="pn-frame-head">
          <span className="pn-task-id">{task.id}</span>
          <span className="pn-frame-name">{task.name}</span>
          <span className="pn-task-status">{status}</span>
        </span>
        {showFrames && frames.length > 0 && (
          <span className="pn-frame-locals">
            {frames.map((frame) => `${frame.name} · line ${frame.line}`).join(' ← ')}
          </span>
        )}
      </div>
    </li>
  )
}

/** `running`, `ready`, `waits to receive from channel #3`, `done · returned 42`. */
export function statusText(task: TaskView, name: (task: number) => string | undefined): string {
  if (task.current && task.status !== 'done') return 'running'
  if (task.status === 'done') {
    // The main script, and functions without a `return`, return nil: not worth saying.
    const nothing = task.result === null || task.result.kind === 'nil'
    return nothing ? 'done' : `done · returned ${formatValue(task.result!)}`
  }
  if (task.status === 'runnable') return 'ready'
  return taskWaitText(task.wait, name)
}
