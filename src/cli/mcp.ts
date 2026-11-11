/**
 * `hindsight mcp` (ARCHITECTURE §9.1): the debugger as a Model Context Protocol server over stdio,
 * so an AI agent can stop guessing what a program does from its text and instead run it, look at
 * any moment, ask where a value came from, try a counterfactual and prove a fix.
 *
 * The transport is MCP's stdio one: JSON-RPC 2.0 messages, one per line. The server is a plain
 * class (`handle` takes a parsed message and returns the reply), so it is tested without a
 * process. Traces live in memory, named `t1`, `t2`, …; the oldest are dropped beyond `MAX_TRACES`.
 */
import {
  backwardSlice,
  compareRecordings,
  compile,
  diffHeaps,
  type EditValue,
  errorSlice,
  LineIndex,
  type ProvenanceEvent,
  queryRecording,
  record,
  type Recording,
  solveInverse,
  type StateView,
  type TracedValue,
  type ValueView,
  whyNot,
  writeName,
} from '../core/index'
import { visibleVariable } from './whatif'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MAX_TRACES = 16
const MAX_OUTPUT_LINES = 200
const MAX_HISTORY = 50
const MAX_SOURCE_LENGTH = 200_000
const MAX_STEPS_CAP = 10_000_000

interface Trace {
  readonly id: string
  readonly source: string
  readonly recording: Recording
  /** The trace this one was forked from. */
  readonly parent: string | null
}

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json }
type Args = Readonly<Record<string, unknown>>

interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Json
  run(args: Args): Json
}

/** A problem with a tool call that the agent can fix: reported as a tool error, not a crash. */
class ToolError extends Error {}

const TRACE_ID = { type: 'string', description: 'A trace id returned by run_trace or fork_whatif' }
const STEP = { type: 'integer', minimum: 0, description: 'A step (time) of the trace, 0..steps' }

function schema(properties: Record<string, Json>, required: readonly string[]): Json {
  return { type: 'object', properties, required: [...required], additionalProperties: false }
}

function valueJson(value: ValueView): Json {
  switch (value.kind) {
    case 'nil':
      return null
    case 'bool':
    case 'number':
    case 'string':
      return value.value
    case 'ref':
      return { object: value.id, type: value.type, preview: value.preview }
  }
}

function tracedJson(value: TracedValue): Json {
  return value !== null && typeof value === 'object' ? { object: value.ref } : value
}

function outcomeJson(recording: Recording): Json {
  const { outcome } = recording
  if (outcome.kind !== 'error') return { kind: outcome.kind }
  const { error } = outcome
  const line = new LineIndex(recording.program.source).lineOf(error.span.start)
  return { kind: 'error', code: error.code, message: error.message, hint: error.hint ?? null, line }
}

function lineOf(recording: Recording, time: number): number | null {
  const location = recording.locationAt(Math.min(time, recording.length))
  return location !== null && location.source === 'main' ? location.line : null
}

function eventJson(recording: Recording, event: ProvenanceEvent): Json {
  return {
    step: event.time,
    line: lineOf(recording, event.time),
    kind: event.kind,
    name: writeName(recording, event),
    value: tracedJson(event.value),
  }
}

export class McpServer {
  private readonly traces = new Map<string, Trace>()
  private nextTrace = 1
  private readonly tools: readonly Tool[]

  constructor(private readonly version: string) {
    this.tools = this.buildTools()
  }

  /** Handles one JSON-RPC message; null when it needs no reply (a notification). */
  handle(message: unknown): Json {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return this.failure(null, -32600, 'Invalid request')
    }
    const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown }
    const replyTo = typeof id === 'string' || typeof id === 'number' ? id : null
    if (typeof method !== 'string') return this.failure(replyTo, -32600, 'Invalid request')
    if (replyTo === null) return null
    const args = (params !== null && typeof params === 'object' ? params : {}) as Args
    switch (method) {
      case 'initialize':
        return this.result(replyTo, {
          protocolVersion:
            typeof args.protocolVersion === 'string' ? args.protocolVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'hindsight', version: this.version },
          instructions:
            'Hindsight is a small language with a time-travel debugger. Call run_trace with a ' +
            'program to record it, then seek_state, query_provenance, fork_whatif, ' +
            'get_divergence, query, why_not, slice and solve to examine the run. Steps are ' +
            'instruction counts; a state at step T is the state before instruction T runs.',
        })
      case 'ping':
        return this.result(replyTo, {})
      case 'tools/list':
        return this.result(replyTo, {
          tools: this.tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        })
      case 'tools/call':
        return this.result(replyTo, this.call(args))
      default:
        return this.failure(replyTo, -32601, `Method not found: ${method}`)
    }
  }

  private result(id: string | number, result: Json): Json {
    return { jsonrpc: '2.0', id, result }
  }

  private failure(id: string | number | null, code: number, message: string): Json {
    return { jsonrpc: '2.0', id, error: { code, message } }
  }

  private call(params: Args): Json {
    const tool = this.tools.find((candidate) => candidate.name === params.name)
    const text = (body: Json, isError: boolean): Json => ({
      content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
      isError,
    })
    if (tool === undefined) return text({ error: `Unknown tool: ${String(params.name)}` }, true)
    const args = (
      params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}
    ) as Args
    try {
      return text(tool.run(args), false)
    } catch (error) {
      if (error instanceof ToolError) return text({ error: error.message }, true)
      throw error
    }
  }

  // --- arguments --------------------------------------------------------------------------------

  private trace(args: Args, key = 'trace_id'): Trace {
    const id = args[key]
    const trace = typeof id === 'string' ? this.traces.get(id) : undefined
    if (trace === undefined) {
      throw new ToolError(
        `No trace ${JSON.stringify(id)}: call run_trace first (traces: ${[...this.traces.keys()].join(', ') || 'none'})`,
      )
    }
    return trace
  }

  private step(args: Args, trace: Trace, key = 'step'): number {
    const step = args[key]
    const { length } = trace.recording
    if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step > length) {
      throw new ToolError(`${key} must be an integer from 0 to ${length}`)
    }
    return step
  }

  private keep(source: string, recording: Recording, parent: string | null): Trace {
    const trace: Trace = { id: `t${this.nextTrace++}`, source, recording, parent }
    this.traces.set(trace.id, trace)
    while (this.traces.size > MAX_TRACES) {
      const oldest = this.traces.keys().next()
      if (oldest.done === true) break
      this.traces.delete(oldest.value)
    }
    return trace
  }

  private summary(trace: Trace): Json {
    const { recording } = trace
    const shown = recording.outputs.slice(0, MAX_OUTPUT_LINES)
    return {
      trace_id: trace.id,
      steps: recording.length,
      outcome: outcomeJson(recording),
      output: shown.map((output) => ({ step: output.time, text: output.text })),
      output_truncated: recording.outputs.length > shown.length,
    }
  }

  // --- tools ------------------------------------------------------------------------------------

  private buildTools(): Tool[] {
    return [
      {
        name: 'run_trace',
        description:
          'Compile and record a Hindsight program. Returns a trace_id, the number of steps, the outcome (finished, error, step-limit) and the output lines with the step that printed each. Compile errors are returned with line numbers.',
        inputSchema: schema(
          {
            source: { type: 'string', description: 'The program text (.sight)' },
            max_steps: {
              type: 'integer',
              minimum: 1,
              description: 'Step limit (default 2,000,000)',
            },
            seed: { type: 'integer', description: 'Seed of the random generator (default 42)' },
          },
          ['source'],
        ),
        run: (args) => this.runTrace(args),
      },
      {
        name: 'seek_state',
        description:
          'The program state at a step: the next instruction and its line, the call stack with every local and captured variable, the globals, and the output printed so far.',
        inputSchema: schema({ trace_id: TRACE_ID, step: STEP }, ['trace_id', 'step']),
        run: (args) => {
          const trace = this.trace(args)
          return stateJson(trace.recording, trace.recording.stateAt(this.step(args, trace)))
        },
      },
      {
        name: 'query_provenance',
        description:
          'Where a variable got its value: the write that produced the value variable `name` (as visible in the innermost frame at `step`) holds, and the history of every write to that binding.',
        inputSchema: schema(
          {
            trace_id: TRACE_ID,
            step: STEP,
            name: { type: 'string', description: 'A variable visible at that step' },
          },
          ['trace_id', 'step', 'name'],
        ),
        run: (args) => this.provenance(args),
      },
      {
        name: 'fork_whatif',
        description:
          'A counterfactual: fork the run at `step` with variable `name` set to `value` (a number, string, boolean or null) and record the new future. Returns a new trace_id for the fork, the step where the futures diverge and how the output changed.',
        inputSchema: schema(
          {
            trace_id: TRACE_ID,
            step: STEP,
            name: { type: 'string', description: 'A variable visible at that step' },
            value: { description: 'The new value: a number, string, boolean or null' },
          },
          ['trace_id', 'step', 'name', 'value'],
        ),
        run: (args) => this.fork(args),
      },
      {
        name: 'get_divergence',
        description:
          'Compare a fork with the run it was forked from (or any two traces of one program): the first step where they behave differently, the line there, the output diff, and the heap references that differ at that step.',
        inputSchema: schema(
          {
            trace_id: TRACE_ID,
            base_trace_id: { type: 'string', description: 'Default: the trace it was forked from' },
          },
          ['trace_id'],
        ),
        run: (args) => this.divergence(args),
      },
      {
        name: 'query',
        description:
          "Find moments by condition instead of stepping. Forms: `when x > 3 and depth > 1` (stretches where it held), `changed(order.paid)` (every write, following the object across functions), `calls(fib) where ret < 0`. Expressions read the program's variables plus depth, step, line, function.",
        inputSchema: schema(
          {
            trace_id: TRACE_ID,
            query: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 1000 },
          },
          ['trace_id', 'query'],
        ),
        run: (args) => this.query(args),
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
          const trace = this.trace(args)
          if (typeof args.line !== 'number') throw new ToolError('line must be a number')
          return whyNot(trace.recording, args.line) as unknown as Json
        },
      },
      {
        name: 'slice',
        description:
          'The dynamic backward slice of a step: the source lines with a causal path (through data or control) to it. Default step: the runtime error, else the last output line. Lines outside the slice cannot have caused it.',
        inputSchema: schema({ trace_id: TRACE_ID, step: STEP }, ['trace_id']),
        run: (args) => this.slice(args),
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
        run: (args) => this.solve(args),
      },
    ]
  }

  private runTrace(args: Args): Json {
    const { source } = args
    if (typeof source !== 'string') throw new ToolError('source must be a string')
    if (source.length > MAX_SOURCE_LENGTH) throw new ToolError('source is too long')
    const maxSteps = typeof args.max_steps === 'number' ? args.max_steps : undefined
    if (
      maxSteps !== undefined &&
      !(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= MAX_STEPS_CAP)
    ) {
      throw new ToolError(`max_steps must be an integer from 1 to ${MAX_STEPS_CAP}`)
    }
    const seed =
      typeof args.seed === 'number' && Number.isSafeInteger(args.seed) ? args.seed : undefined
    const compiled = compile(source)
    if (!compiled.ok) {
      const index = new LineIndex(source)
      return {
        compiled: false,
        diagnostics: compiled.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          hint: diagnostic.hint ?? null,
          line: index.lineCol(diagnostic.span.start).line,
          column: index.lineCol(diagnostic.span.start).col,
        })),
      }
    }
    const recording = record(compiled.program, { maxSteps, seed })
    return this.summary(this.keep(source, recording, null))
  }

  private provenance(args: Args): Json {
    const trace = this.trace(args)
    const step = this.step(args, trace)
    const { recording } = trace
    const name = String(args.name)
    const variable = visibleVariable(recording.stateAt(step), name)
    if (variable === null)
      throw new ToolError(`No variable named '${name}' is visible at step ${step}`)
    const origin = recording.origin(variable.target, step)
    const history = recording.history(variable.target, step, { limit: MAX_HISTORY })
    return {
      name,
      value: valueJson(variable.value),
      origin: origin === null ? null : eventJson(recording, origin),
      history: history.events.map((event) => eventJson(recording, event)),
      history_total: history.total,
    }
  }

  private fork(args: Args): Json {
    const trace = this.trace(args)
    const step = this.step(args, trace)
    const name = String(args.name)
    const value = args.value
    const primitive = value === null || ['number', 'string', 'boolean'].includes(typeof value)
    if (!primitive) throw new ToolError('value must be a number, a string, a boolean or null')
    const variable = visibleVariable(trace.recording.stateAt(step), name)
    if (variable === null)
      throw new ToolError(`No variable named '${name}' is visible at step ${step}`)
    const fork = trace.recording.fork(step, { target: variable.target, value: value as EditValue })
    if (!fork.ok) throw new ToolError(fork.error.message)
    const kept = this.keep(trace.source, fork.recording, trace.id)
    return {
      ...(this.summary(kept) as { readonly [key: string]: Json }),
      forked_from: trace.id,
      was: valueJson(variable.value),
      ...(comparisonJson(trace.recording, fork.recording, false) as {
        readonly [key: string]: Json
      }),
    }
  }

  private divergence(args: Args): Json {
    const trace = this.trace(args)
    const baseId = typeof args.base_trace_id === 'string' ? args.base_trace_id : trace.parent
    if (baseId === null) throw new ToolError('This trace is not a fork: give base_trace_id')
    const base = this.trace({ trace_id: baseId })
    if (base.recording.program !== trace.recording.program) {
      throw new ToolError('The two traces are runs of different programs')
    }
    return comparisonJson(base.recording, trace.recording, true)
  }

  private query(args: Args): Json {
    const trace = this.trace(args)
    const limit = typeof args.limit === 'number' ? Math.min(1000, Math.max(1, args.limit)) : 100
    const outcome = queryRecording(trace.recording, String(args.query), { limit })
    if (!outcome.ok) throw new ToolError(outcome.error)
    const { result } = outcome
    const { recording } = trace
    switch (result.kind) {
      case 'when':
        return {
          kind: 'when',
          matches: result.matches,
          intervals: result.intervals.map((interval) => ({
            from: interval.from,
            to: interval.to,
            line: lineOf(recording, interval.from),
          })),
          truncated: result.truncated,
        }
      case 'changed':
        return {
          kind: 'changed',
          total: result.total,
          events: result.events.map((event) => eventJson(recording, event)),
          truncated: result.truncated,
        }
      case 'calls':
        return {
          kind: 'calls',
          total: result.total,
          calls: result.calls.map((call) => ({ ...call })),
          truncated: result.truncated,
        }
    }
  }

  private slice(args: Args): Json {
    const trace = this.trace(args)
    const { recording } = trace
    const fallback =
      recording.outcome.kind === 'error'
        ? recording.length
        : (recording.outputs.at(-1)?.time ?? null)
    const step = args.step === undefined ? fallback : this.step(args, trace)
    if (step === null) throw new ToolError('The run printed nothing and did not fail: give a step')
    const slice =
      step === recording.length
        ? (errorSlice(recording) ?? backwardSlice(recording, step))
        : backwardSlice(recording, step)
    if (slice === null) throw new ToolError('This run is too long to analyze')
    const ran = [...recording.lineHitCounts().keys()].sort((a, b) => a - b)
    const lines = [...slice.lines].sort((a, b) => a - b)
    return {
      step,
      lines,
      steps_in_slice: slice.steps,
      lines_that_ran: ran,
      lines_ruled_out: ran.filter((line) => !slice.lines.has(line)),
    }
  }

  private solve(args: Args): Json {
    const trace = this.trace(args)
    const { recording } = trace
    let result
    if (args.no_crash === true) result = solveInverse(recording, { kind: 'no-error' })
    else {
      if (typeof args.want !== 'string') throw new ToolError('Give want (a text) or no_crash: true')
      const line =
        typeof args.output_line === 'number' ? args.output_line : recording.outputs.length
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
}

function stateJson(recording: Recording, state: StateView): Json {
  const { location } = state
  const index = new LineIndex(recording.program.source)
  const printed = recording.outputs.slice(0, state.outputCount)
  return {
    step: state.time,
    steps: recording.length,
    location:
      location === null
        ? null
        : {
            line: location.source === 'main' ? location.line : null,
            function: location.functionName,
            library: location.library,
            instruction: location.opName,
            depth: location.depth,
          },
    frames: [...state.frames].reverse().map((frame) => ({
      function: frame.name,
      line: frame.library ? null : index.lineOf(frame.span.start),
      locals: Object.fromEntries(frame.locals.map((local) => [local.name, valueJson(local.value)])),
      captured: Object.fromEntries(
        frame.captures.map((capture) => [capture.name, valueJson(capture.value)]),
      ),
    })),
    globals: Object.fromEntries(
      state.globals.map((global) => [global.name, valueJson(global.value)]),
    ),
    output_lines_so_far: printed.length,
    last_output: printed.slice(-10).map((output) => output.text),
    error: state.error === null ? null : { code: state.error.code, message: state.error.message },
  }
}

function comparisonJson(base: Recording, fork: Recording, withHeap: boolean): Json {
  const comparison = compareRecordings(base, fork)
  const step = comparison.divergence
  const changed = comparison.lines.filter((line) => line.kind !== 'same').slice(0, MAX_OUTPUT_LINES)
  const result: Record<string, Json> = {
    divergence_step: step,
    divergence_line: step === null ? null : lineOf(fork, step),
    base: { steps: base.length, outcome: outcomeJson(base) },
    fork: { steps: fork.length, outcome: outcomeJson(fork) },
    output_lines_removed: comparison.removed,
    output_lines_added: comparison.added,
    output_diff: changed.map((line) => `${line.kind === 'removed' ? '-' : '+'} ${line.text}`),
  }
  if (withHeap && step !== null) {
    // One step on: the state just after both runs did the first thing they did differently.
    const diff = diffHeaps(
      base.stateAt(Math.min(step + 1, base.length)),
      fork.stateAt(Math.min(step + 1, fork.length)),
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

/** Feeds lines of JSON to `server` and writes each reply on its own line. */
export function serveLine(server: McpServer, line: string, write: (text: string) => void): void {
  const text = line.trim()
  if (text === '') return
  let message: unknown
  try {
    message = JSON.parse(text)
  } catch {
    write(
      `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
    )
    return
  }
  let reply: Json
  try {
    reply = server.handle(message)
  } catch (error) {
    const id = (message as { id?: unknown } | null)?.id
    reply = {
      jsonrpc: '2.0',
      id: typeof id === 'string' || typeof id === 'number' ? id : null,
      error: { code: -32603, message: `Internal error: ${(error as Error).message}` },
    }
  }
  if (reply !== null) write(`${JSON.stringify(reply)}\n`)
}
