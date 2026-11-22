/**
 * The MCP server's tools for programs with tasks (ARCHITECTURE §9.1, SPEC §10.6): the `schedule`
 * argument run_trace takes, the task part of states and outcomes, and `explore_schedules`, the race
 * finder: the program recorded under many random schedules, its distinct results, and for the
 * first two, where they diverge, the shared places more than one task wrote, and the calls where
 * the difference starts.
 */
import {
  DEFAULT_QUANTUM,
  DEFAULT_SCHEDULE_RUNS,
  exploreSchedules,
  type OriginGroup,
  type RaceCandidate,
  type ScheduleGroup,
  type ScheduleOptions,
  type TaskView,
} from '../core/index'
import { MAX_QUANTUM } from '../core/tasks-info'
import {
  type Args,
  clampedArg,
  integerArg,
  type Json,
  MAX_STEPS,
  outcomeJson,
  schema,
  SEED,
  SOURCE,
  type Tool,
  type ToolContext,
  ToolError,
  TRACE_ID,
  waitJson,
} from './mcp-shared'

/** Schedules explore_schedules tries at most in one call. */
export const MAX_EXPLORE_RUNS = 200
/** Groups kept as traces (the rest are only counted). */
const GROUPS_KEPT = 5
const SEEDS_LISTED = 20
const OUTPUT_LISTED = 20
const ORIGINS_LISTED = 5

export const SCHEDULE: Json = {
  type: 'object',
  description:
    'How tasks interleave (programs that call spawn): {"policy": "round-robin"} (the default: a task runs until it blocks, yields or ends) or {"policy": "random", "seed": S, "quantum": Q} (preempted after 1..Q instructions, next task drawn from a generator seeded with S). Same program + same seeds = same run.',
  properties: {
    policy: { type: 'string', enum: ['round-robin', 'random'] },
    seed: { type: 'integer', minimum: 0, description: 'Schedule seed (default 1)' },
    quantum: { type: 'integer', minimum: 1, maximum: MAX_QUANTUM, description: 'Default 10' },
  },
  required: ['policy'],
  additionalProperties: false,
}

/** The `schedule` argument, checked; undefined when absent (round-robin). */
export function scheduleArg(args: Args): ScheduleOptions | undefined {
  const value = args.schedule
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolError('schedule must be an object such as {"policy": "random", "seed": 3}')
  }
  const schedule = value as Args
  const policy = schedule.policy
  if (policy !== 'round-robin' && policy !== 'random') {
    throw new ToolError('schedule.policy must be "round-robin" or "random"')
  }
  const seed = integerArg(schedule, 'seed', 1, 0, 0xffffffff)
  const quantum = integerArg(schedule, 'quantum', DEFAULT_QUANTUM, 1, MAX_QUANTUM)
  return policy === 'random' ? { policy, seed, quantum } : undefined
}

/** Every task of a state (seek_state), innermost frame first. */
export function tasksJson(tasks: readonly TaskView[]): Json {
  return tasks.map((task) => ({
    task: task.id,
    name: task.name,
    status: task.status,
    running: task.current,
    wait: waitJson(task.wait),
    frames: [...task.frames].reverse().map((frame) => ({
      function: frame.name,
      line: frame.library ? null : frame.line,
    })),
  }))
}

export function exploreTool(context: ToolContext): Tool {
  return {
    name: 'explore_schedules',
    description:
      "Find races in a program with tasks: records it (source, or the program of trace_id) under `runs` random schedules (seeds seed, seed+1, …; default 20), groups the runs by outcome and output, and keeps one run per group as a trace. When the groups differ it reports where the first two diverge, the race candidates (shared variables, fields and lists written by more than one task before the first differing output, with the lines) and the calls where the difference starts. Inspect a group's trace with seek_state or diff_runs.",
    inputSchema: schema(
      {
        source: SOURCE,
        trace_id: TRACE_ID,
        runs: { type: 'integer', minimum: 2, maximum: MAX_EXPLORE_RUNS },
        seed: { type: 'integer', minimum: 0, description: 'The first schedule seed (default 1)' },
        quantum: { type: 'integer', minimum: 1, maximum: MAX_QUANTUM, description: 'Default 10' },
        max_steps: MAX_STEPS,
        program_seed: {
          ...SEED,
          description: "Seed of the program's random() for every run (default 42)",
        },
      },
      [],
    ),
    run: (args) => explore(context, args),
  }
}

function explore(context: ToolContext, args: Args): Json {
  const base = context.traceOrSource(args, 'trace_id', 'source')
  const runs = clampedArg(args, 'runs', DEFAULT_SCHEDULE_RUNS, 2, MAX_EXPLORE_RUNS)
  const found = exploreSchedules(base.recording.program, {
    runs,
    seed: integerArg(args, 'seed', 1, 0, 0xffffffff),
    quantum: integerArg(args, 'quantum', DEFAULT_QUANTUM, 1, MAX_QUANTUM),
    maxSteps:
      args.max_steps === undefined ? undefined : integerArg(args, 'max_steps', 1, 1, 10_000_000),
    programSeed: typeof args.program_seed === 'number' ? Math.trunc(args.program_seed) : undefined,
  })
  const traces = new Map<ScheduleGroup, string>()
  for (const group of found.groups.slice(0, GROUPS_KEPT)) {
    traces.set(group, context.keep(base.source, group.recording, null).id)
  }
  const result: Record<string, Json> = {
    runs: found.runs,
    quantum: found.quantum,
    uses_tasks: found.usesTasks,
    results: found.groups.length,
    groups: found.groups.map((group) => groupJson(group, traces.get(group) ?? null)),
    divergence: null,
  }
  const divergence = found.divergence
  if (divergence !== null) {
    result.divergence = {
      seed_a: divergence.seedA,
      seed_b: divergence.seedB,
      trace_a: traces.get(found.groups[0]!) ?? null,
      trace_b: traces.get(found.groups[1]!) ?? null,
      step: divergence.step,
      output_index: divergence.outputIndex,
      until_step: divergence.until,
      race_candidates: divergence.candidates.map(candidateJson),
      origins: divergence.diff.origins.items.slice(0, ORIGINS_LISTED).map(originJson),
    }
  }
  if (!found.usesTasks)
    result.note = 'The program never started a task: every schedule runs it the same way.'
  return result
}

function groupJson(group: ScheduleGroup, traceId: string | null): Json {
  return {
    runs: group.seeds.length,
    seeds: group.seeds.slice(0, SEEDS_LISTED),
    trace_id: traceId,
    outcome: outcomeJson(group.recording),
    output: group.outputs.slice(0, OUTPUT_LISTED),
    output_total: group.outputs.length,
  }
}

function candidateJson(candidate: RaceCandidate): Json {
  return {
    name: candidate.name,
    writers: candidate.writers.map((writer) => ({
      task: writer.task,
      name: writer.name,
      writes: writer.writes,
    })),
    lines: [...candidate.lines],
  }
}

function originJson(origin: OriginGroup): Json {
  return {
    function: origin.a.name,
    a: `${origin.a.signature} ${origin.a.did}`,
    b: `${origin.b.signature} ${origin.b.did}`,
    changes: [...origin.changes],
  }
}
