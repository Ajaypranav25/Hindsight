/**
 * The MCP server's tools for one recorded run (ARCHITECTURE §9.1): record it, look at a moment,
 * ask where a value came from, fork a what-if and compare it, explain a line that never ran,
 * slice, and solve backwards. Each tool is a plain function of its arguments over the trace store.
 */
import {
  backwardSlice,
  compareRecordings,
  diffHeaps,
  type EditValue,
  errorSlice,
  SLICE_LENGTH_PROBLEM,
  sliceProblem,
  type Recording,
  solveInverse,
  whyNot,
} from '../core/index'
import {
  type Args,
  booleanArg,
  choiceArg,
  clampedArg,
  eventJson,
  integerArg,
  type Json,
  type JsonObject,
  lineOf,
  MAX_STEPS,
  outcomeJson,
  page,
  schema,
  SEED,
  SOURCE,
  STEP,
  stringArg,
  type Tool,
  type ToolContext,
  ToolError,
  type Trace,
  TRACE_ID,
  valueJson,
} from './mcp-shared'
import {
  DEFAULT_VALUE_LIMITS,
  type FrameChoice,
  MAX_VALUE_DEPTH,
  MAX_VALUE_ITEMS,
  stateJson,
} from './mcp-state'
import { SCHEDULE } from './mcp-races'
import { visibleVariable } from './whatif'

export const DEFAULT_OUTPUT_LIMIT = 100
export const MAX_OUTPUT_LIMIT = 1000
const MAX_DIFF_LINES = 200
const MAX_HISTORY = 50

const OUTPUT_PAGING = {
  output_offset: { type: 'integer', minimum: 0, description: 'Output lines to skip (default 0)' },
  output_limit: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_OUTPUT_LIMIT,
    description: `Output lines to return (default ${DEFAULT_OUTPUT_LIMIT})`,
  },
} as const

/** A trace's steps, outcome and a page of its output (`output_offset`, `output_limit`). */
export function traceSummary(trace: Trace, args: Args): JsonObject {
  const { recording } = trace
  const offset = integerArg(args, 'output_offset', 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = clampedArg(args, 'output_limit', DEFAULT_OUTPUT_LIMIT, 1, MAX_OUTPUT_LIMIT)
  const shown = page(recording.outputs, offset, limit)
  return {
    trace_id: trace.id,
    steps: recording.length,
    outcome: outcomeJson(recording),
    output: shown.items.map((output) => ({ step: output.time, text: output.text })),
    output_total: shown.total,
    output_offset: offset,
    output_truncated: shown.next !== null,
    more_output:
      shown.next === null
        ? null
        : `run_trace {trace_id: "${trace.id}", output_offset: ${shown.next}} returns the next lines`,
  }
}

export function coreTools(context: ToolContext): Tool[] {
  return [
    {
      name: 'run_trace',
      description:
        'Start here. Compile and record a Hindsight program (source), or page through the output of a trace you already have (trace_id). Returns a trace_id for every other tool, the number of steps, the outcome (finished, error with code/message/line, step-limit) and output lines with the step that printed each (first 100 by default; output_total says how many there are). Compile errors come back with line and column. A crash? Call diagnose_failure next.',
      inputSchema: schema(
        {
          source: SOURCE,
          trace_id: TRACE_ID,
          max_steps: MAX_STEPS,
          seed: SEED,
          schedule: SCHEDULE,
          ...OUTPUT_PAGING,
        },
        [],
      ),
      run: (args) => {
        if (args.source === undefined && typeof args.trace_id === 'string') {
          return traceSummary(context.trace(args), args)
        }
        return runTrace(context, args)
      },
    },
    {
      name: 'seek_state',
      description:
        'The program state at a step: the next instruction and its line, the call stack (innermost first) with every local and captured variable, the globals, and the output printed so far. Budget the answer with max_depth (list/record nesting expanded, default 1, 0 = previews), max_items (items per list or record, default 20), frames ("all", "top" or a number of innermost frames) and include_globals.',
      inputSchema: schema(
        {
          trace_id: TRACE_ID,
          step: STEP,
          max_depth: { type: 'integer', minimum: 0, maximum: MAX_VALUE_DEPTH },
          max_items: { type: 'integer', minimum: 1, maximum: MAX_VALUE_ITEMS },
          frames: {
            description: '"all" (default), "top", or how many innermost frames to show',
            anyOf: [
              { type: 'string', enum: ['all', 'top'] },
              { type: 'integer', minimum: 1 },
            ],
          },
          include_globals: { type: 'boolean', description: 'Default true' },
        },
        ['trace_id', 'step'],
      ),
      run: (args) => seekState(context, args),
    },
    {
      name: 'query_provenance',
      description:
        'Where a variable got its value: the write that produced the value of `name` (as visible in the innermost frame at `step`), with its step and line, and the history of every write to that binding (the first 50, with the total). Use it to walk a wrong value back to its source.',
      inputSchema: schema(
        {
          trace_id: TRACE_ID,
          step: STEP,
          name: { type: 'string', description: 'A variable visible at that step' },
        },
        ['trace_id', 'step', 'name'],
      ),
      run: (args) => provenance(context, args),
    },
    {
      name: 'fork_whatif',
      description:
        'Test a hypothesis without editing the program: fork the run at `step` with variable `name` set to `value` (a number, string, boolean or null) and record the new future. Returns a new trace_id for the fork, the step where the futures diverge and how the output changed.',
      inputSchema: schema(
        {
          trace_id: TRACE_ID,
          step: STEP,
          name: { type: 'string', description: 'A variable visible at that step' },
          value: { description: 'The new value: a number, string, boolean or null' },
          ...OUTPUT_PAGING,
        },
        ['trace_id', 'step', 'name', 'value'],
      ),
      run: (args) => fork(context, args),
    },
    {
      name: 'get_divergence',
      description:
        'Compare a fork with the run it was forked from (or any two traces of one program): the first step where they behave differently, the line there, the output diff, and the heap references that differ at that step. For two different programs (versions of a file), use diff_runs.',
      inputSchema: schema(
        {
          trace_id: TRACE_ID,
          base_trace_id: { type: 'string', description: 'Default: the trace it was forked from' },
        },
        ['trace_id'],
      ),
      run: (args) => divergence(context, args),
    },
    {
      name: 'why_not',
      description:
        'Why a source line never ran: the guard (if, loop, match arm) that decided against it, the value of its condition, its operands and where they were set; or that its function was never called.',
      inputSchema: schema({ trace_id: TRACE_ID, line: { type: 'integer', minimum: 1 } }, [
        'trace_id',
        'line',
      ]),
      run: (args) => {
        const trace = context.trace(args)
        if (typeof args.line !== 'number') throw new ToolError('line must be a number')
        return whyNot(trace.recording, args.line) as unknown as Json
      },
    },
    {
      name: 'slice',
      description:
        'The dynamic backward slice of a step: the source lines with a causal path (through data or control) to it. Default step: the runtime error, else the last output line. Lines outside the slice cannot have caused it, so they can be ruled out. diagnose_failure includes this with the line texts.',
      inputSchema: schema({ trace_id: TRACE_ID, step: STEP }, ['trace_id']),
      run: (args) => slice(context, args),
    },
    {
      name: 'solve',
      description:
        'Inverse what-if: search for an earlier variable value that makes an output line read `want` (give `output_line`, 1-based; default the last), or with `no_crash: true` that avoids the runtime error. Returns sentences like "If rate at step 12 had been 0.5 instead of 0.2, line 5 would have printed 100".',
      inputSchema: schema(
        {
          trace_id: TRACE_ID,
          want: { type: 'string' },
          output_line: { type: 'integer', minimum: 1 },
          no_crash: { type: 'boolean' },
        },
        ['trace_id'],
      ),
      run: (args) => solve(context, args),
    },
  ]
}

function runTrace(context: ToolContext, args: Args): Json {
  if (args.source === undefined) {
    throw new ToolError('Give source (a program) or trace_id (to page through its output)')
  }
  const recorded = context.recordSource(args.source, args)
  return recorded.ok ? traceSummary(recorded.trace, args) : recorded.failure
}

function frameChoice(args: Args): FrameChoice {
  const frames = args.frames
  if (frames === undefined || frames === null) return 'all'
  if (typeof frames === 'number') return integerArg(args, 'frames', 1, 1, Number.MAX_SAFE_INTEGER)
  return choiceArg(args, 'frames', ['all', 'top'] as const, 'all')
}

function seekState(context: ToolContext, args: Args): Json {
  const trace = context.trace(args)
  const step = context.step(args, trace)
  const limits = {
    depth: integerArg(args, 'max_depth', DEFAULT_VALUE_LIMITS.depth, 0, MAX_VALUE_DEPTH),
    items: integerArg(args, 'max_items', DEFAULT_VALUE_LIMITS.items, 1, MAX_VALUE_ITEMS),
  }
  const globals = booleanArg(args, 'include_globals', true)
  return stateJson(trace.recording, trace.recording.stateAt(step), {
    limits,
    frames: frameChoice(args),
    globals,
  })
}

function provenance(context: ToolContext, args: Args): Json {
  const trace = context.trace(args)
  const step = context.step(args, trace)
  const { recording } = trace
  const name = String(args.name)
  const variable = visibleVariable(recording.stateAt(step), name)
  if (variable === null) {
    throw new ToolError(`No variable named '${name}' is visible at step ${step}`)
  }
  const origin = recording.origin(variable.target, step)
  const history = recording.history(variable.target, step, { limit: MAX_HISTORY })
  return {
    name,
    value: valueJson(variable.value),
    origin: origin === null ? null : eventJson(recording, origin),
    history: history.events.map((event) => eventJson(recording, event)),
    history_total: history.total,
    history_truncated: history.truncated,
  }
}

function fork(context: ToolContext, args: Args): Json {
  const trace = context.trace(args)
  const step = context.step(args, trace)
  const name = String(args.name)
  const value = args.value
  const primitive = value === null || ['number', 'string', 'boolean'].includes(typeof value)
  if (!primitive) throw new ToolError('value must be a number, a string, a boolean or null')
  const variable = visibleVariable(trace.recording.stateAt(step), name)
  if (variable === null) {
    throw new ToolError(`No variable named '${name}' is visible at step ${step}`)
  }
  const result = trace.recording.fork(step, {
    target: variable.target,
    value: value as EditValue,
  })
  if (!result.ok) throw new ToolError(result.error.message)
  const kept = context.keep(trace.source, result.recording, trace.id)
  return {
    ...traceSummary(kept, args),
    forked_from: trace.id,
    was: valueJson(variable.value),
    ...comparisonJson(trace.recording, result.recording, false),
  }
}

function divergence(context: ToolContext, args: Args): Json {
  const trace = context.trace(args)
  const baseId = stringArg(args, 'base_trace_id') ?? trace.parent
  if (baseId === null) throw new ToolError('This trace is not a fork: give base_trace_id')
  const base = context.trace({ trace_id: baseId })
  if (base.recording.program !== trace.recording.program) {
    throw new ToolError(
      'The two traces are runs of different programs: use diff_runs to compare them',
    )
  }
  return comparisonJson(base.recording, trace.recording, true)
}

function slice(context: ToolContext, args: Args): Json {
  const trace = context.trace(args)
  const { recording } = trace
  const fallback =
    recording.outcome.kind === 'error' ? recording.length : (recording.outputs.at(-1)?.time ?? null)
  const step = args.step === undefined ? fallback : context.step(args, trace)
  if (step === null) throw new ToolError('The run printed nothing and did not fail: give a step')
  const found =
    step === recording.length
      ? (errorSlice(recording) ?? backwardSlice(recording, step))
      : backwardSlice(recording, step)
  if (found === null) throw new ToolError(sliceProblem(recording) ?? SLICE_LENGTH_PROBLEM)
  const ran = [...recording.lineHitCounts().keys()].sort((a, b) => a - b)
  const lines = [...found.lines].sort((a, b) => a - b)
  return {
    step,
    lines,
    steps_in_slice: found.steps,
    lines_that_ran: ran,
    lines_ruled_out: ran.filter((line) => !found.lines.has(line)),
  }
}

function solve(context: ToolContext, args: Args): Json {
  const trace = context.trace(args)
  const { recording } = trace
  let result
  if (args.no_crash === true) result = solveInverse(recording, { kind: 'no-error' })
  else {
    if (typeof args.want !== 'string') throw new ToolError('Give want (a text) or no_crash: true')
    const line = typeof args.output_line === 'number' ? args.output_line : recording.outputs.length
    result = solveInverse(recording, { kind: 'output', index: line - 1, text: args.want })
  }
  if (result.problem !== null) throw new ToolError(result.problem)
  return {
    solutions: result.solutions.map((solution) => ({
      sentence: solution.sentence,
      name: solution.candidate.name,
      step: solution.candidate.time,
      line: solution.candidate.line,
      original: solution.candidate.original,
      value: solution.value,
    })),
    candidates_tried: result.candidates,
    forks: result.forks,
    budget_exhausted: result.exhausted,
  }
}

function comparisonJson(base: Recording, other: Recording, withHeap: boolean): JsonObject {
  const comparison = compareRecordings(base, other)
  const step = comparison.divergence
  const changed = comparison.lines.filter((line) => line.kind !== 'same')
  const result: Record<string, Json> = {
    divergence_step: step,
    divergence_line: step === null ? null : lineOf(other, step),
    base: { steps: base.length, outcome: outcomeJson(base) },
    fork: { steps: other.length, outcome: outcomeJson(other) },
    output_lines_removed: comparison.removed,
    output_lines_added: comparison.added,
    output_diff: changed
      .slice(0, MAX_DIFF_LINES)
      .map((line) => `${line.kind === 'removed' ? '-' : '+'} ${line.text}`),
    output_diff_truncated: changed.length > MAX_DIFF_LINES,
  }
  if (withHeap && step !== null) {
    // One step on: the state just after both runs did the first thing they did differently.
    const diff = diffHeaps(
      base.stateAt(Math.min(step + 1, base.length)),
      other.stateAt(Math.min(step + 1, other.length)),
    )
    const edge = (e: { from: string; label: string; to: number }): Json =>
      `${e.from}${e.label === '' ? '' : ` ${e.label}`} -> #${e.to}`
    result.heap_at_divergence = {
      references_only_in_fork: diff.added.map(edge),
      references_only_in_base: diff.removed.map(edge),
    }
  }
  return result
}
