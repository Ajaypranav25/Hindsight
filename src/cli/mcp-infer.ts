/**
 * The `infer_contracts` tool (ARCHITECTURE §7.17, §9.1): likely `requires`/`ensures` clauses for
 * the functions of a run, each held in every recorded call and checked by recording the program
 * again with the clauses written in. Meant for a version the agent trusts: added to the program,
 * the clauses let `find_bug` answer its own questions on a later, broken version.
 */
import { callTree, type FunctionContracts, inferContracts, withContracts } from '../core/index'
import {
  booleanArg,
  clampedArg,
  type Json,
  MAX_STEPS,
  outcomeJson,
  schema,
  SEED,
  SOURCE,
  stringArg,
  type Tool,
  type ToolContext,
  ToolError,
  TRACE_ID,
} from './mcp-shared'

export const INFER_DEFAULT_PER_FUNCTION = 6
export const INFER_MAX_PER_FUNCTION = 20
const INFER_MAX_FUNCTIONS = 40

function functionJson(fn: FunctionContracts): Json {
  return {
    function: fn.name,
    line: fn.line,
    calls: fn.calls,
    calls_read: fn.sampled,
    different_inputs: fn.inputs,
    existing: [...fn.existing],
    suggestions: fn.suggestions.map((s) => ({
      kind: s.kind,
      clause: s.clause,
      template: s.template,
      pins_result: s.pins,
      support: { calls: s.support.calls, inputs: s.support.inputs },
      example: s.example.text,
      example_step: s.example.entry,
    })),
    note: fn.note,
  }
}

export function inferContractsTool(context: ToolContext): Tool {
  return {
    name: 'infer_contracts',
    description:
      'Contract inference (Daikon-style likely invariants): for each function declared with fn that returned with at least 3 different argument tuples, suggests requires/ensures clauses that held in every recorded call (types, non-nil, signs, order and length relations, membership, sortedness, result == a parameter or a builtin of one, small integer linear relations). Each clause is checked by recording the program again with it written in. Use it on a version you trust, add the clauses you agree with to the fn headers (`fn f(x)\\n  requires x > 0\\n  ensures result == 2 * x\\n{`), and on a later, broken version find_bug answers its own questions from them (an ensures clause that pins the result down answers every call). The clauses describe what the program did, not what it must do: review them. Pass seed when the trace was recorded with a non-default seed.',
    inputSchema: schema(
      {
        trace_id: TRACE_ID,
        source: SOURCE,
        max_steps: MAX_STEPS,
        seed: SEED,
        function: { type: 'string', description: 'Only this function (by name)' },
        min_inputs: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Different argument tuples a function and a clause need (default 3)',
        },
        max_per_function: {
          type: 'integer',
          minimum: 1,
          maximum: INFER_MAX_PER_FUNCTION,
          description: `Suggestions per function (default ${INFER_DEFAULT_PER_FUNCTION})`,
        },
        include_source: {
          type: 'boolean',
          description: 'Also return the program with every suggestion written in (default false)',
        },
      },
      [],
    ),
    run(args) {
      const trace = context.traceOrSource(args, 'trace_id', 'source')
      const only = stringArg(args, 'function')
      // The seed the trace was recorded with, as recordSource reads it (the check records again).
      const seed =
        typeof args.seed === 'number' && Number.isSafeInteger(args.seed) ? args.seed : undefined
      const result = inferContracts(trace.recording, callTree(trace.recording), {
        fn: only ?? undefined,
        minInputs: clampedArg(args, 'min_inputs', 3, 1, 50),
        maxPerFunction: clampedArg(
          args,
          'max_per_function',
          INFER_DEFAULT_PER_FUNCTION,
          1,
          INFER_MAX_PER_FUNCTION,
        ),
        seed,
      })
      if (only !== null && result.functions.length === 0) {
        throw new ToolError(`no function '${only}' declared with fn in this program`)
      }
      const listed = result.functions.slice(0, INFER_MAX_FUNCTIONS)
      const body: { [key: string]: Json } = {
        trace_id: trace.id,
        outcome: outcomeJson(trace.recording),
        verified: result.verified,
        withdrawn: result.withdrawn,
        problem: result.problem,
        functions: listed.map(functionJson),
        functions_total: result.functions.length,
      }
      if (booleanArg(args, 'include_source', false)) {
        body.source_with_contracts = withContracts(trace.source, result.functions)
      }
      body.next_steps = [
        'add the clauses you agree with to the fn headers of the trusted version',
        'run find_bug on a later version: contract answers come from these clauses',
        'example_step: seek_state there to see a call the clause held in',
      ]
      return body
    },
  }
}
