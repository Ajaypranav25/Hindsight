/**
 * `hindsight mcp` (ARCHITECTURE §9.1): the debugger as a Model Context Protocol server over stdio,
 * so an AI agent can stop guessing what a program does from its text and instead run it, look at
 * any moment, ask where a value came from, try a counterfactual and prove a fix.
 *
 * The transport is MCP's stdio one: JSON-RPC 2.0 messages, one per line. The server is a plain
 * class (`handle` takes a parsed message and returns the reply), so it is tested without a
 * process. Traces live in memory, named `t1`, `t2`, …; the oldest are dropped beyond `MAX_TRACES`.
 * Results are compact JSON text, shortened by the size guard when they would not fit an agent's
 * context window (`mcp-guard.ts`). The tools live in `mcp-tools.ts`, `mcp-query.ts`,
 * `mcp-diagnose.ts`, `mcp-repair.ts`, `mcp-find-bug.ts`, `mcp-diff.ts`, `mcp-profile.ts` and
 * `mcp-infer.ts`.
 */
import { compile, LineIndex, record, type Recording } from '../core/index'
import { diagnoseTool } from './mcp-diagnose'
import { diffTool } from './mcp-diff'
import { findBugTool } from './mcp-find-bug'
import { traceFileTools } from './mcp-trace-file'
import { guardResponse } from './mcp-guard'
import { inferContractsTool } from './mcp-infer'
import { profileTool } from './mcp-profile'
import { queryTool } from './mcp-query'
import { suggestRepairsTool } from './mcp-repair'
import {
  type Args,
  integerArg,
  type Json,
  MAX_SOURCE_LENGTH,
  MAX_STEPS_CAP,
  type RecordedSource,
  type Tool,
  type ToolContext,
  ToolError,
  type Trace,
} from './mcp-shared'
import { coreTools } from './mcp-tools'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MAX_TRACES = 16

const INSTRUCTIONS =
  'Hindsight is a small language with a time-travel debugger. Call run_trace with a program to ' +
  'record it (a trace_id comes back), then examine the run instead of guessing: ' +
  'diagnose_failure explains a crash or a wrong output line in one call (stack, values, slice, ' +
  'causal chain, verified one-token repairs); find_bug localizes a wrong result by asking about ' +
  'calls (stateless: pass the answers so far); suggest_repairs checks one-token fixes against ' +
  'expected results; diff_runs compares two versions of a program (or two inputs) call by call ' +
  'and names where the difference starts. seek_state, query_provenance, query, why_not, slice, ' +
  'fork_whatif, get_divergence and solve answer narrower questions; profile shows where the ' +
  'steps went; infer_contracts suggests requires/ensures clauses from a trusted run, which ' +
  'find_bug then reads on a broken one. Steps are instruction ' +
  'counts; the state at step T is the state before instruction T runs. Long results come in ' +
  'pages: each result says when it was cut and how to fetch more.'

export class McpServer implements ToolContext {
  private readonly traces = new Map<string, Trace>()
  private nextTrace = 1
  private readonly tools: readonly Tool[]

  constructor(readonly version: string) {
    const core = coreTools(this)
    this.tools = [
      ...core.slice(0, 5),
      queryTool(this),
      ...core.slice(5),
      diffTool(this),
      diagnoseTool(this),
      suggestRepairsTool(this),
      findBugTool(this),
      profileTool(this),
      inferContractsTool(this),
      ...traceFileTools(this),
    ]
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
          instructions: INSTRUCTIONS,
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
      content: [{ type: 'text', text: JSON.stringify(guardResponse(body)) }],
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

  // --- the tool context -------------------------------------------------------------------------

  trace(args: Args, key = 'trace_id'): Trace {
    const id = args[key]
    const trace = typeof id === 'string' ? this.traces.get(id) : undefined
    if (trace === undefined) {
      throw new ToolError(
        `No trace ${JSON.stringify(id)}: call run_trace first (traces: ${[...this.traces.keys()].join(', ') || 'none'})`,
      )
    }
    return trace
  }

  step(args: Args, trace: Trace, key = 'step'): number {
    const step = args[key]
    const { length } = trace.recording
    if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step > length) {
      throw new ToolError(`${key} must be an integer from 0 to ${length}`)
    }
    return step
  }

  keep(source: string, recording: Recording, parent: string | null): Trace {
    const trace: Trace = { id: `t${this.nextTrace++}`, source, recording, parent }
    this.traces.set(trace.id, trace)
    while (this.traces.size > MAX_TRACES) {
      const oldest = this.traces.keys().next()
      if (oldest.done === true) break
      this.traces.delete(oldest.value)
    }
    return trace
  }

  recordSource(source: unknown, args: Args): RecordedSource {
    if (typeof source !== 'string') throw new ToolError('source must be a string')
    if (source.length > MAX_SOURCE_LENGTH) throw new ToolError('source is too long')
    const maxSteps =
      args.max_steps === undefined ? undefined : integerArg(args, 'max_steps', 1, 1, MAX_STEPS_CAP)
    const seed =
      typeof args.seed === 'number' && Number.isSafeInteger(args.seed) ? args.seed : undefined
    const compiled = compile(source)
    if (!compiled.ok) {
      const index = new LineIndex(source)
      return {
        ok: false,
        failure: {
          compiled: false,
          diagnostics: compiled.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            hint: diagnostic.hint ?? null,
            line: index.lineCol(diagnostic.span.start).line,
            column: index.lineCol(diagnostic.span.start).col,
          })),
        },
      }
    }
    const recording = record(compiled.program, { maxSteps, seed })
    return { ok: true, trace: this.keep(source, recording, null) }
  }

  traceOrSource(args: Args, traceKey: string, sourceKey: string): Trace {
    if (args[traceKey] !== undefined) return this.trace(args, traceKey)
    if (args[sourceKey] === undefined) throw new ToolError(`Give ${traceKey} or ${sourceKey}`)
    const recorded = this.recordSource(args[sourceKey], args)
    if (recorded.ok) return recorded.trace
    throw new ToolError(
      `The program does not compile: ${JSON.stringify(recorded.failure.diagnostics)}`,
    )
  }
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
