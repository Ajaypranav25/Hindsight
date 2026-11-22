/**
 * The `diagnose_failure` tool (ARCHITECTURE §9.1): one round trip that explains a failed run. For
 * a crash: the error with its hint, the stack with source lines, the values the failing statement
 * reads, the backward slice as source lines, the causal chain of writes that fed the failure, and
 * verified one-token repairs. For a wrong output line: the same view from the step that printed
 * it, plus inverse what-if candidates that would make it read the expected text. For a run that
 * hit the step limit: the stack where it stopped and the hottest lines. Every search is bounded
 * by counts derived from the run's length, never by the clock, so results are deterministic.
 */
import {
  backwardSlice,
  errorSlice,
  SLICE_LENGTH_PROBLEM,
  sliceProblem,
  type FrameView,
  lex,
  LineIndex,
  type Recording,
  type Slice,
  solveInverse,
  type Span,
  type StateView,
  type TracedValue,
  upstreamWrites,
  type ValueView,
} from '../core/index'
import { deepText } from '../core/call-values'
import { searchRepairs } from './lab'
import { MUTANTS, REPAIRS, repairsJson } from './mcp-repair'
import {
  type Args,
  integerArg,
  type Json,
  type JsonObject,
  MAX_STEPS,
  outcomeJson,
  schema,
  SEED,
  SOURCE,
  sourceLine,
  stringArg,
  type Tool,
  type ToolContext,
  ToolError,
  type Trace,
  TRACE_ID,
  tracedJson,
} from './mcp-shared'
import { deepValueJson } from './mcp-state'

const MAX_SLICE_LINES = 80
const MAX_CHAIN = 40
const MAX_READS = 16
const MAX_HOT_LINES = 5
const CHAIN_TEXT = 120
const RANGE = { offset: 0, limit: 1 } as const
const VALUE_LIMITS = { depth: 1, items: 10 } as const
/** Steps all repair mutants may run together; caps the mutant count on long runs. */
const REPAIR_STEP_BUDGET = 40_000_000
const DEFAULT_MUTANTS = 120
const DEFAULT_REPAIRS = 3

export function diagnoseTool(context: ToolContext): Tool {
  return {
    name: 'diagnose_failure',
    description:
      'One call that explains a failed run. For a crash: error code, message and hint, the line, the call stack with source lines, the values of the variables the failing statement reads, the backward slice (only these lines can have caused it) with their text, the causal chain of writes that fed the failure (name, value, step, line), and up to max_repairs verified one-token repairs (with how many mutants were checked). For a run that finished but printed a wrong line: give output_index (0-based) or output_line (1-based) and expected; you get the slice from that print and inverse what-if candidates. For a run that hit the step limit: where it was looping. Ends with next_steps naming the tools to use.',
    inputSchema: schema(
      {
        trace_id: TRACE_ID,
        source: SOURCE,
        max_steps: MAX_STEPS,
        seed: SEED,
        output_index: { type: 'integer', minimum: 0, description: 'A wrong output line, 0-based' },
        output_line: { type: 'integer', minimum: 1, description: 'A wrong output line, 1-based' },
        expected: { type: 'string', description: 'What that output line should read' },
        max_mutants: MUTANTS,
        max_repairs: REPAIRS,
      },
      [],
    ),
    run: (args) => diagnose(context, args),
  }
}

function diagnose(context: ToolContext, args: Args): Json {
  const trace = context.traceOrSource(args, 'trace_id', 'source')
  const { recording } = trace
  const index = outputIndex(args, recording)
  if (index !== null) return wrongOutput(trace, args, index)
  switch (recording.outcome.kind) {
    case 'error':
      return crash(trace, args)
    case 'step-limit':
    case 'aborted':
      return stopped(trace)
    case 'finished':
      return {
        trace_id: trace.id,
        status: 'finished',
        outcome: outcomeJson(recording),
        output_lines: recording.outputs.length,
        next_steps: [
          'The run did not crash. If an output line is wrong, call diagnose_failure again with output_index (0-based) and expected.',
          'If a function returns a wrong value, find_bug localizes it; suggest_repairs with expectations proposes fixes.',
        ],
      }
  }
}

function outputIndex(args: Args, recording: Recording): number | null {
  const count = recording.outputs.length
  if (args.output_index !== undefined) {
    if (count === 0) throw new ToolError('The run printed nothing')
    return integerArg(args, 'output_index', 0, 0, count - 1)
  }
  if (args.output_line !== undefined) {
    if (count === 0) throw new ToolError('The run printed nothing')
    return integerArg(args, 'output_line', 1, 1, count) - 1
  }
  return null
}

// --- crashes ------------------------------------------------------------------------------------

function crash(trace: Trace, args: Args): Json {
  const { recording, source } = trace
  const { outcome } = recording
  if (outcome.kind !== 'error') throw new ToolError('The run did not crash')
  const { error } = outcome
  const index = new LineIndex(source)
  const at = index.lineCol(error.span.start)
  const state = recording.stateAt(recording.length)
  const slice = errorSlice(recording)
  const repairs = searchRepairs(recording, { kind: 'crash' }, repairBudget(args, recording))
  return {
    trace_id: trace.id,
    status: 'crashed',
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint ?? null,
      step: error.time,
      line: at.line,
      column: at.col,
      source_line: sourceLine(source, at.line),
      expression: source.slice(error.span.start, error.span.end).slice(0, 200),
    },
    stack: error.stack.map((entry) => {
      const line = entry.library ? null : index.lineOf(entry.span.start)
      return {
        function: entry.name,
        line,
        source_line: sourceLine(source, line),
        span: entry.library ? null : { start: entry.span.start, end: entry.span.end },
        library: entry.library,
      }
    }),
    ...statementJson(recording, source, state),
    ...sliceJson(recording, source, slice),
    repairs: repairsJson(repairs),
    next_steps: [
      ...(repairs.repairs.length > 0
        ? ['Check the repairs: each makes the run finish, but only one may be what you meant.']
        : []),
      'query_provenance at the failing step explains where a value in "values" came from.',
      'solve with no_crash: true searches for an earlier value that avoids the crash.',
      'seek_state at an earlier step of the causal chain shows the state before it went wrong.',
    ],
  }
}

function repairBudget(args: Args, recording: Recording) {
  const perMutant = Math.max(recording.length * 4, recording.length + 50_000)
  const affordable = Math.max(10, Math.floor(REPAIR_STEP_BUDGET / perMutant))
  return {
    maxMutants: Math.min(integerArg(args, 'max_mutants', DEFAULT_MUTANTS, 1, 400), affordable),
    maxRepairs: integerArg(args, 'max_repairs', DEFAULT_REPAIRS, 1, 10),
  }
}

/** The innermost frame running user code: library frames are the prelude's, not the program's. */
function userFrame(state: StateView): FrameView | null {
  for (let i = state.frames.length - 1; i >= 0; i--) {
    const frame = state.frames[i]!
    if (!frame.library) return frame
  }
  return null
}

/** The variable names a statement reads (identifiers that are not field names or record keys). */
export function readsOf(source: string, span: Span): string[] {
  const text = source.slice(span.start, span.end)
  const { tokens } = lex(text)
  const names: string[] = []
  for (let i = 0; i < tokens.length && names.length < MAX_READS; i++) {
    const token = tokens[i]!
    if (token.kind !== 'Identifier') continue
    if (tokens[i - 1]?.kind === '.' || tokens[i + 1]?.kind === ':') continue
    const name = String(token.value)
    if (!names.includes(name)) names.push(name)
  }
  return names
}

function lookup(frame: FrameView, state: StateView, name: string): ValueView | null {
  const local = frame.locals.findLast((candidate) => candidate.name === name)
  const capture = frame.captures.find((candidate) => candidate.name === name)
  const global = state.globals.find((candidate) => candidate.name === name)
  return (local ?? capture ?? global)?.value ?? null
}

/** The statement running at `state` and the values of the variables it reads, at that step. */
function statementJson(recording: Recording, source: string, state: StateView): JsonObject {
  const frame = userFrame(state)
  if (frame === null) return { statement: null, values: {} }
  const span = frame.stmtSpan
  const index = new LineIndex(source)
  const values: [string, Json][] = []
  for (const name of readsOf(source, span)) {
    const value = lookup(frame, state, name)
    if (value === null) continue
    if (value.kind === 'ref' && (value.type === 'function' || value.type === 'builtin')) continue
    values.push([name, deepValueJson(recording, state.time, value, VALUE_LIMITS).json])
  }
  const text = source.slice(span.start, span.end)
  return {
    statement: {
      function: frame.name,
      line: index.lineOf(span.start),
      text: text.length > 300 ? `${text.slice(0, 299)}…` : text,
    },
    values: Object.fromEntries(values),
  }
}

/** The slice as numbered source lines, and the writes in it (closest to the criterion last). */
function sliceJson(recording: Recording, source: string, slice: Slice | null): JsonObject {
  if (slice === null) {
    const note = sliceProblem(recording) ?? SLICE_LENGTH_PROBLEM
    return { slice: null, causal_chain: [], causal_chain_note: note }
  }
  const lines = [...slice.lines].sort((a, b) => a - b)
  const ran = [...recording.lineHitCounts().keys()].sort((a, b) => a - b)
  // Function declarations feed every call; they explain nothing, so they are left out.
  const writes = upstreamWrites(recording, slice).filter(
    (write) => write.name !== null && !isFunction(recording, write.event.time, write.event.value),
  )
  const chain = writes.slice(-MAX_CHAIN)
  return {
    slice: {
      lines: lines
        .slice(0, MAX_SLICE_LINES)
        .map((line) => ({ line, text: sourceLine(source, line) })),
      lines_total: lines.length,
      steps: slice.steps,
      lines_ruled_out: ran.filter((line) => !slice.lines.has(line)),
    },
    causal_chain: chain.map((write) => ({
      name: write.name,
      value: chainValue(recording, write.event.time, write.event.value),
      step: write.event.time,
      line: write.line,
    })),
    causal_chain_total: writes.length,
    ...(writes.length > chain.length
      ? {
          causal_chain_note: `the last ${chain.length} of ${writes.length} writes (nearest the failure)`,
        }
      : {}),
  }
}

function isFunction(recording: Recording, time: number, value: TracedValue): boolean {
  if (value === null || typeof value !== 'object') return false
  const type = recording.objectAt(Math.min(time + 1, recording.length), value.ref, RANGE)?.type
  return type === 'function' || type === 'builtin'
}

/** A written value: primitives as they are, objects with their text just after the write. */
function chainValue(recording: Recording, time: number, value: TracedValue): Json {
  if (value === null || typeof value !== 'object') return tracedJson(value)
  const at = Math.min(time + 1, recording.length)
  const object = recording.objectAt(at, value.ref, RANGE)
  if (object === null) return tracedJson(value)
  const view: ValueView = { kind: 'ref', id: value.ref, type: object.type, preview: '' }
  const text = deepText(recording, at, view, 'display', CHAIN_TEXT)
  return { object: value.ref, type: object.type, text: text?.text ?? null }
}

// --- wrong output and runs that stopped ---------------------------------------------------------

function wrongOutput(trace: Trace, args: Args, index: number): Json {
  const { recording, source } = trace
  const output = recording.outputs[index]!
  const expected = stringArg(args, 'expected')
  const slice = backwardSlice(recording, output.time)
  const inverse =
    expected === null ? null : solveInverse(recording, { kind: 'output', index, text: expected })
  return {
    trace_id: trace.id,
    status: 'wrong-output',
    outcome: outcomeJson(recording),
    output: { index, line_number: index + 1, step: output.time, text: output.text, expected },
    ...statementJson(recording, source, recording.stateAt(output.time)),
    ...sliceJson(recording, source, slice),
    inverse:
      inverse === null
        ? null
        : {
            candidates: inverse.solutions.map((solution) => ({
              sentence: solution.sentence,
              name: solution.candidate.name,
              step: solution.candidate.time,
              line: solution.candidate.line,
              original: solution.candidate.original,
              value: solution.value,
            })),
            candidates_tried: inverse.candidates,
            forks: inverse.forks,
            budget_exhausted: inverse.exhausted,
            problem: inverse.problem,
          },
    next_steps: [
      ...(expected === null
        ? ['Give expected to search for earlier values that fix the line.']
        : []),
      'find_bug localizes the function whose own code is wrong by asking about its calls.',
      'suggest_repairs with expectations ({"call": "f(1)", "expected": "2"}) proposes verified one-token fixes.',
    ],
  }
}

function stopped(trace: Trace): Json {
  const { recording, source } = trace
  const state = recording.stateAt(recording.length)
  const hot = [...recording.lineHitCounts()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_HOT_LINES)
  const index = new LineIndex(source)
  return {
    trace_id: trace.id,
    status: recording.outcome.kind,
    outcome: outcomeJson(recording),
    stack: [...state.frames].reverse().map((frame) => {
      const line = frame.library ? null : index.lineOf(frame.span.start)
      return { function: frame.name, line, source_line: sourceLine(source, line) }
    }),
    ...statementJson(recording, source, state),
    hottest_lines: hot.map(([line, hits]) => ({ line, hits, text: sourceLine(source, line) })),
    next_steps: [
      'A loop whose condition never becomes false is the usual cause: query "changed(NAME)" on its loop variable shows whether it moves.',
      'run_trace with a larger max_steps if the program is merely long.',
    ],
  }
}
