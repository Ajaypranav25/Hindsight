/**
 * The `profile` tool (ARCHITECTURE §7.16, §9.1): where a run spent its steps, for an agent looking
 * for a slow function or a loop that runs too often. The top functions by inclusive steps, the top
 * lines and, on request, the heaviest folded stacks; each list is cut to `top` with its total.
 */
import { profile } from '../core/index'
import {
  booleanArg,
  clampedArg,
  type Json,
  MAX_STEPS,
  outcomeJson,
  schema,
  SEED,
  SOURCE,
  sourceLine,
  type Tool,
  type ToolContext,
  TRACE_ID,
} from './mcp-shared'

export const PROFILE_DEFAULT_TOP = 20
export const PROFILE_MAX_TOP = 200

/** A share of `whole` in percent, rounded to one decimal. */
function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((1000 * part) / whole) / 10
}

export function profileTool(context: ToolContext): Tool {
  return {
    name: 'profile',
    description:
      'Step profiler: where did the run spend its steps (one step = one instruction, so the numbers are exact and repeatable)? Returns the top functions by inclusive steps (with exclusive steps, calls, average and largest call, share of the run), the lines whose statements took the most steps, and with folded: true the heaviest stack paths (`<top level>;main;fib 1234`). Library code is folded into the user calls that made it unless just_my_code is false. Use it when a run is slow or hits the step limit, before optimizing, or to see which function a loop spends its time in.',
    inputSchema: schema(
      {
        trace_id: TRACE_ID,
        source: SOURCE,
        max_steps: MAX_STEPS,
        seed: SEED,
        top: {
          type: 'integer',
          minimum: 1,
          maximum: PROFILE_MAX_TOP,
          description: `Rows per list (default ${PROFILE_DEFAULT_TOP})`,
        },
        just_my_code: {
          type: 'boolean',
          description: 'Fold library calls into their callers (default true)',
        },
        folded: {
          type: 'boolean',
          description: 'Also list the heaviest folded stacks (default false)',
        },
      },
      [],
    ),
    run(args) {
      const trace = context.traceOrSource(args, 'trace_id', 'source')
      const top = clampedArg(args, 'top', PROFILE_DEFAULT_TOP, 1, PROFILE_MAX_TOP)
      const justMyCode = booleanArg(args, 'just_my_code', true)
      const withFolded = booleanArg(args, 'folded', false)
      const { recording, source } = trace
      const result = profile(recording, { justMyCode })
      const { steps } = result
      const body: { [key: string]: Json } = {
        trace_id: trace.id,
        steps,
        outcome: outcomeJson(recording),
        just_my_code: justMyCode,
        functions: result.functions.slice(0, top).map((fn) => ({
          function: fn.label,
          line: fn.lines?.start ?? null,
          library: fn.library,
          calls: fn.calls,
          inclusive: fn.inclusive,
          exclusive: fn.exclusive,
          share: share(fn.inclusive, steps),
          average: Math.round(fn.average * 10) / 10,
          max: fn.max,
          first_step: fn.firstEntry,
        })),
        functions_total: result.functions.length,
        lines: result.lines.slice(0, top).map((line) => ({
          line: line.line,
          steps: line.steps,
          share: share(line.steps, steps),
          text: sourceLine(source, line.line)?.trim() ?? null,
        })),
        lines_total: result.lines.length,
      }
      if (withFolded) {
        const heaviest = [...result.folded].sort((a, b) => b.steps - a.steps).slice(0, top)
        body.folded = heaviest.map((entry) => `${entry.stack} ${entry.steps}`)
        body.folded_total = result.folded.length
      }
      body.next_steps = [
        "seek_state at a function's first_step to see its arguments",
        'query with `calls(NAME)` to list the calls of a hot function',
      ]
      return body
    },
  }
}
