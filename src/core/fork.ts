/**
 * What-if forks (ARCHITECTURE §7.5). A fork at step T copies its parent's trace, events,
 * allocations and output before T (never appending to the parent's buffers), positions a fresh VM
 * at T, writes the edit there (recorded as a `write` event at T), snapshots the edited state as a
 * pinned seek barrier, and records a new future from T.
 */
import type {
  ForkEdit,
  ForkError,
  ForkErrorCode,
  ForkOptions,
  OutputEvent,
  WhatIfInfo,
} from './api-types'
import { InternalError } from './diagnostics'
import { isEditValue, resolveEditTarget, writeEdit } from './fork-edit'
import { type RecordingCore, RecordingSession } from './recorder-session'
import type { VM } from './runtime-types'
import { TraceSink } from './trace-sink'

export type PreparedFork =
  | { readonly ok: true; readonly session: RecordingSession; readonly whatIf: WhatIfInfo }
  | { readonly ok: false; readonly error: ForkError }

/** A recording session for the fork, positioned just after the edit (or why there is none). */
export function prepareFork(
  core: RecordingCore,
  parent: WhatIfInfo | null,
  time: number,
  edit: ForkEdit,
  options: ForkOptions,
): PreparedFork {
  const problem = requestProblem(core, time, edit, options)
  if (problem !== null) return problem
  const vm = positionedVM(core, time)
  const slot = resolveEditTarget(vm, edit.target, time)
  if (typeof slot === 'string') return failure('target', slot)
  // Earlier edits at `time` are already in the state there; their events are the first rows at it.
  const kept = (parent?.edits ?? []).filter((earlier) => earlier.time <= time)
  const rows =
    core.events.firstRowAt(time, core.eventCount) + kept.filter((e) => e.time === time).length
  const sink = new TraceSink(
    core.events.copyPrefix(rows),
    core.allocs.copyBefore(time),
    outputsBefore(core.outputs, time),
    rows,
  )
  const applied = { target: slot.target, value: edit.value }
  sink.write(time, 'write', applied.target, applied.value)
  sink.keep = sink.eventCount
  writeEdit(vm, slot, applied.value)
  vm.hooks = sink
  const maxSteps = options.maxSteps === undefined ? core.maxSteps : Math.floor(options.maxSteps)
  const session = new RecordingSession({
    program: core.program,
    runtime: core.runtime,
    seed: core.seed,
    heapLimit: options.heapLimit ?? core.heapLimit,
    steps: core.steps.copyPrefix(time),
    events: sink.events,
    allocs: sink.allocs,
    sink,
    schedule: core.schedule.forkAt(time, vm.snapshot()),
    vm,
    start: time,
    stopAt: maxSteps,
    maxSteps,
  })
  const edits = [...kept, { time, edit: applied }]
  return { ok: true, session, whatIf: { parentLength: core.length, time, edit: applied, edits } }
}

function failure(code: ForkErrorCode, message: string): PreparedFork {
  return { ok: false, error: { code, message } }
}

function requestProblem(
  core: RecordingCore,
  time: number,
  edit: ForkEdit,
  options: ForkOptions,
): PreparedFork | null {
  if (!Number.isInteger(time) || time < 0 || time >= core.length) {
    const range = core.length === 0 ? 'the run has no steps' : `steps are 0..${core.length - 1}`
    return failure('time', `cannot fork at step ${time}: ${range}`)
  }
  if (!isEditValue(edit.value)) {
    return failure('value', 'a what-if value must be nil, a bool, a number or a string')
  }
  if (options.maxSteps !== undefined && !(Math.floor(options.maxSteps) > time)) {
    return failure('max-steps', `the step limit must be above the fork step ${time}`)
  }
  return null
}

/** A fresh, unhooked VM in the parent's state at `time`. */
function positionedVM(core: RecordingCore, time: number): VM {
  const { runtime } = core
  const vm = runtime.createVM(core.program, {
    builtins: runtime.builtins,
    libraryProtos: runtime.libraryProtos,
    seed: core.seed,
  })
  vm.restore(core.schedule.latestAtOrBefore(time).snapshot)
  vm.runUntil(time)
  if (vm.time !== time || vm.status !== 'running') {
    throw new InternalError(`cannot position a fork at step ${time}`)
  }
  return vm
}

function outputsBefore(outputs: readonly OutputEvent[], time: number): OutputEvent[] {
  let end = 0
  while (end < outputs.length && outputs[end]!.time < time) end++
  return outputs.slice(0, end)
}
