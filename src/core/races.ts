/**
 * The race finder (ARCHITECTURE §7.16): records a program with tasks under many random schedules
 * (SPEC §10.6), groups the runs by what they did (outcome and output) and, when they disagree,
 * explains the disagreement between a run of the commonest group and one of the next: where the
 * two schedules first ran something different, the call-tree difference (`diffRuns`), and the
 * race candidates: the shared places (variables, fields, elements, lists) that more than one task
 * wrote between that divergence and the first output that differs.
 */
import {
  DEFAULT_QUANTUM,
  DEFAULT_SEED,
  type Outcome,
  type ProvenanceEvent,
  type RecordOptions,
  type Recording,
  type ScheduleOptions,
  type StateView,
  type WriteTarget,
} from './api-types'
import type { Program } from './bytecode'
import { eventsBetween } from './events'
import { replayAccess } from './recorder'
import { diffRuns, type RunDiff } from './run-diff'
import { writeName } from './slice'
import { MAX_QUANTUM } from './tasks-info'

export const DEFAULT_SCHEDULE_RUNS = 20
export const MAX_SCHEDULE_RUNS = 500
/** Steps each run may take unless told otherwise. */
export const DEFAULT_EXPLORE_STEPS = 1_000_000
/** The most events of one run read for race candidates. */
const CANDIDATE_EVENT_LIMIT = 200_000
const CANDIDATE_LIMIT = 20

export interface ExploreOptions {
  /** How many schedules to try. Default 20, at most 500. */
  readonly runs?: number
  /** The first schedule seed; run `i` uses `seed + i`. Default 1. */
  readonly seed?: number
  /** The random policy's quantum. Default 10. */
  readonly quantum?: number
  /** The program's own random seed (`random()`), the same for every run. Default 42. */
  readonly programSeed?: number
  /** Step limit per run. Default 1,000,000. */
  readonly maxSteps?: number
}

/** The runs that did the same thing. */
export interface ScheduleGroup {
  readonly outcome: Outcome
  readonly outputs: readonly string[]
  /** The schedule seeds that produced it, ascending. */
  readonly seeds: readonly number[]
  /** The run of the first of those seeds. */
  readonly recording: Recording
}

export interface RaceWriter {
  readonly task: number
  readonly name: string
  readonly writes: number
}

export interface RaceCandidate {
  /** `balance`, `account.total`, `xs[2]`, `#12[0]` (an object no variable named). */
  readonly name: string
  readonly target: WriteTarget
  /** The tasks that wrote it in the window, by task number. */
  readonly writers: readonly RaceWriter[]
  /** The lines of those writes, ascending. */
  readonly lines: readonly number[]
}

export interface ScheduleDivergence {
  /** The schedule seeds of the two runs compared (a: the commonest group). */
  readonly seedA: number
  readonly seedB: number
  /** The first step at which the two runs ran another task or instruction. */
  readonly step: number
  /** The first output line that differs (its index), or null when only the outcomes differ. */
  readonly outputIndex: number | null
  /** The step of run A up to which writes were examined (that output, else the end). */
  readonly until: number
  readonly diff: RunDiff
  /** Shared places written by more than one task in that window, most writers first. */
  readonly candidates: readonly RaceCandidate[]
}

export interface ScheduleExploration {
  readonly runs: number
  readonly quantum: number
  /** Distinct behaviors, the commonest first (ties: the earliest seed). */
  readonly groups: readonly ScheduleGroup[]
  /** False when the program never ran with tasks: every schedule is then the same. */
  readonly usesTasks: boolean
  /** Why the first two groups differ; null when every run did the same. */
  readonly divergence: ScheduleDivergence | null
}

type RecordFn = (program: Program, options: RecordOptions) => Recording

/** Records `program` under `runs` random schedules and explains how their behaviors differ. */
export function exploreSchedulesWith(
  recordRun: RecordFn,
  program: Program,
  options: ExploreOptions = {},
): ScheduleExploration {
  const runs = Math.min(
    MAX_SCHEDULE_RUNS,
    Math.max(1, Math.floor(options.runs ?? DEFAULT_SCHEDULE_RUNS)),
  )
  const quantum = Math.min(MAX_QUANTUM, Math.max(1, Math.floor(options.quantum ?? DEFAULT_QUANTUM)))
  const first = Math.floor(options.seed ?? 1)
  const groups = new Map<string, { group: MutableGroup }>()
  let usesTasks = false
  for (let i = 0; i < runs; i++) {
    const seed = (first + i) >>> 0
    const schedule: ScheduleOptions = { policy: 'random', quantum, seed }
    const recording = recordRun(program, {
      schedule,
      seed: options.programSeed ?? DEFAULT_SEED,
      maxSteps: options.maxSteps ?? DEFAULT_EXPLORE_STEPS,
    })
    usesTasks ||= recording.taskSeries() !== null
    const key = behaviorKey(recording)
    const known = groups.get(key)
    if (known === undefined) groups.set(key, { group: newGroup(recording, seed) })
    else known.group.seeds.push(seed)
  }
  const ordered = [...groups.values()]
    .map(({ group }) => group)
    .sort((x, y) => y.seeds.length - x.seeds.length || x.seeds[0]! - y.seeds[0]!)
  const divergence = ordered.length < 2 ? null : diverge(ordered[0]!, ordered[1]!)
  return { runs, quantum, groups: ordered, usesTasks, divergence }
}

interface MutableGroup extends ScheduleGroup {
  readonly seeds: number[]
}

function newGroup(recording: Recording, seed: number): MutableGroup {
  return {
    outcome: recording.outcome,
    outputs: recording.outputs.map((event) => event.text),
    seeds: [seed],
    recording,
  }
}

/** What a run did, as a key: its outcome (an error by code, message and place) and its output. */
function behaviorKey(recording: Recording): string {
  const { outcome } = recording
  const end =
    outcome.kind === 'error'
      ? `error ${outcome.error.code} ${outcome.error.span.start} ${outcome.error.message}`
      : outcome.kind
  return JSON.stringify([end, recording.outputs.map((event) => event.text)])
}

function diverge(a: ScheduleGroup, b: ScheduleGroup): ScheduleDivergence {
  const ra = a.recording
  const rb = b.recording
  const step = firstDifference(ra, rb)
  const outputIndex = firstOutputDifference(a.outputs, b.outputs)
  const output = outputIndex === null ? undefined : ra.outputs[outputIndex]
  const until = output === undefined ? ra.length : output.time + 1
  return {
    seedA: a.seeds[0]!,
    seedB: b.seeds[0]!,
    step,
    outputIndex,
    until,
    diff: diffRuns(ra, rb),
    candidates: raceCandidates(ra, Math.min(step, until), until),
  }
}

/** The first step at which the runs ran another task or another instruction (or one stopped). */
function firstDifference(a: Recording, b: Recording): number {
  const sa = replayAccess(a)?.core.steps
  const sb = replayAccess(b)?.core.steps
  const ta = a.taskSeries()
  const tb = b.taskSeries()
  const length = Math.min(a.length, b.length)
  if (sa === undefined || sb === undefined) return 0
  for (let t = 0; t < length; t++) {
    if ((ta?.[t] ?? 1) !== (tb?.[t] ?? 1)) return t
    if (sa.protoIds[t] !== sb.protoIds[t] || sa.ips[t] !== sb.ips[t]) return t
  }
  return length
}

function firstOutputDifference(a: readonly string[], b: readonly string[]): number | null {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? null : length
}

interface Tally {
  readonly target: WriteTarget
  readonly first: ProvenanceEvent
  readonly byTask: Map<number, number>
  readonly lines: Set<number>
}

/** Shared places written by two tasks or more during steps `from..until` of `recording`. */
export function raceCandidates(recording: Recording, from: number, until: number): RaceCandidate[] {
  const tasks = recording.taskSeries()
  if (tasks === null) return []
  const window = eventsBetween(recording, from, until, CANDIDATE_EVENT_LIMIT)
  const tallies = new Map<string, Tally>()
  for (const event of window.events) {
    if (event.kind === 'declare' || event.kind === 'alloc') continue
    const target = placeOf(event)
    const key = JSON.stringify(target)
    let tally = tallies.get(key)
    if (tally === undefined) {
      tally = { target, first: event, byTask: new Map(), lines: new Set() }
      tallies.set(key, tally)
    }
    const task = tasks[event.time]!
    tally.byTask.set(task, (tally.byTask.get(task) ?? 0) + 1)
    const line = recording.locationAt(event.time)
    if (line !== null && !line.library) tally.lines.add(line.stmtLine)
  }
  const names = taskNames(recording)
  return [...tallies.values()]
    .filter((tally) => tally.byTask.size > 1)
    .sort((x, y) => y.byTask.size - x.byTask.size || x.first.time - y.first.time)
    .slice(0, CANDIDATE_LIMIT)
    .map((tally) => ({
      name: placeName(recording, tally),
      target: tally.target,
      writers: [...tally.byTask]
        .sort(([x], [y]) => x - y)
        .map(([task, writes]) => ({ task, name: names.get(task) ?? `task ${task}`, writes })),
      lines: [...tally.lines].sort((x, y) => x - y),
    }))
}

/** A list change counts against the whole list; any other write against its own place. */
function placeOf(event: ProvenanceEvent): WriteTarget {
  const { target } = event
  if (event.kind === 'list' && target.kind === 'element') {
    return { kind: 'object', objectId: target.objectId }
  }
  return target
}

function taskNames(recording: Recording): Map<number, string> {
  const tasks = recording.stateAt(recording.length).tasks ?? []
  return new Map(tasks.map((task) => [task.id, task.name]))
}

function placeName(recording: Recording, tally: Tally): string {
  const { target, first } = tally
  switch (target.kind) {
    case 'field':
      return `${objectName(recording, first.time, target.objectId)}.${target.key}`
    case 'element':
      return `${objectName(recording, first.time, target.objectId)}[${target.index}]`
    case 'object':
      return objectName(recording, first.time, target.objectId)
    default:
      return writeName(recording, first) ?? describeLocal(recording, first)
  }
}

/** The variable holding object `id` just before step `time` (a global, else a local), or `#id`. */
function objectName(recording: Recording, time: number, id: number): string {
  const state: StateView = recording.stateAt(time)
  const holds = (value: { readonly kind: string; readonly id?: number }): boolean =>
    value.kind === 'ref' && value.id === id
  const global = state.globals.find((each) => holds(each.value))
  if (global !== undefined) return global.name
  for (let i = state.frames.length - 1; i >= 0; i--) {
    const local = state.frames[i]!.locals.find((each) => holds(each.value))
    if (local !== undefined) return local.name
  }
  return `#${id}`
}

function describeLocal(recording: Recording, event: ProvenanceEvent): string {
  const location = recording.locationAt(event.time)
  return location === null ? 'a variable' : `a variable written on line ${location.line}`
}
