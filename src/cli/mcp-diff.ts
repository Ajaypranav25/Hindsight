/**
 * The `diff_runs` tool (ARCHITECTURE §7.14, §9.1): differential execution for agents. Two runs,
 * of two versions of a program or of one program with an input changed, are compared call by
 * call; the result names the calls only one run made, the matched calls that behaved differently
 * and the origins, the functions where the difference starts. Both runs are kept as traces, so
 * the agent can look inside either with the other tools.
 */
import {
  type ChangedCall,
  type DiffCall,
  diffRuns,
  type DiffList,
  formatLiteral,
  type LineSpan,
  type OriginGroup,
  type RunDiff,
  type UnmatchedCall,
  withInput,
} from '../core/index'
import { originReason } from './diff'
import {
  type Args,
  clampedArg,
  type Json,
  type JsonObject,
  jsonLiteral,
  MAX_STEPS,
  outcomeJson,
  schema,
  SEED,
  type Tool,
  type ToolContext,
  ToolError,
  type Trace,
} from './mcp-shared'
import { checkExpectations, type Expectation, EXPECTATIONS, parseExpectations } from './mcp-repair'

export const DIFF_DEFAULT_LIMIT = 20
export const DIFF_MAX_LIMIT = 200
const MAX_OUTPUT_DIFF = 200

interface Sides {
  readonly a: Trace
  readonly b: Trace
  readonly input: JsonObject | null
}

export function diffTool(context: ToolContext): Tool {
  return {
    name: 'diff_runs',
    description:
      'Differential execution: why does version B behave differently from version A? Records both runs and aligns them by call tree (matching calls by function name, so renamed, inserted and removed calls are found), then reports both outcomes, the output diff, the top-most calls only one run made, the matched calls whose result or side effects changed, and the ORIGINS: calls given the same inputs that behaved differently while every call they made behaved the same, i.e. where the difference starts in a function\'s own code. Give source_a and source_b (two versions), trace_a and trace_b (two trace ids), or source (or trace_id) plus set {"name": "scores", "value": "[70, 80]"} to change a top-level let/var initializer (an input). Use it to check a fix (old vs new; add expectations to see each one judged in both runs) or to find which input change matters.',
    inputSchema: schema(
      {
        source_a: { type: 'string', description: 'Program A (.sight text)' },
        source_b: { type: 'string', description: 'Program B (.sight text)' },
        trace_a: { type: 'string', description: 'Trace id of run A' },
        trace_b: { type: 'string', description: 'Trace id of run B' },
        source: { type: 'string', description: 'One program, run as written (A) and with set (B)' },
        trace_id: {
          type: 'string',
          description: 'A trace whose program is run again with set (B)',
        },
        set: {
          description:
            'B\'s input: {"name": a top-level let/var, "value": a literal as text such as 5, "[70, 80]" or "\\"text\\"" (a string that is not a literal is taken as text), or a JSON value: number, boolean, null, array, object}; or "NAME=VALUE"',
          anyOf: [
            {
              type: 'object',
              properties: { name: { type: 'string' }, value: {} },
              required: ['name', 'value'],
            },
            { type: 'string' },
          ],
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: DIFF_MAX_LIMIT,
          description: `Entries listed per category (default ${DIFF_DEFAULT_LIMIT}); totals are always given`,
        },
        expectations: {
          ...EXPECTATIONS,
          description:
            'What some calls should return (as for suggest_repairs): each is checked in both runs, to confirm a fix',
        },
        max_steps: MAX_STEPS,
        seed: SEED,
      },
      [],
    ),
    run: (args) => {
      const limit = clampedArg(args, 'limit', DIFF_DEFAULT_LIMIT, 1, DIFF_MAX_LIMIT)
      const sides = loadSides(context, args)
      const diff = diffRuns(sides.a.recording, sides.b.recording, { limit })
      const json = diffJson(sides, diff)
      if (args.expectations === undefined) return json
      return { ...json, ...expectationsJson(sides, parseExpectations(args.expectations)) }
    },
  }
}

function loadSides(context: ToolContext, args: Args): Sides {
  if (args.set !== undefined) {
    const a = context.traceOrSource(args, 'trace_id', 'source')
    const { name, value } = setting(args.set)
    const input = withInput(a.source, name, value)
    if (!input.ok) throw new ToolError(input.error)
    const recorded = context.recordSource(input.source, args)
    if (!recorded.ok) {
      throw new ToolError(
        `With ${name} = ${input.now} the program does not compile: ${JSON.stringify(recorded.failure)}`,
      )
    }
    const b = recorded.trace
    return {
      a,
      b,
      input: { name, line: input.line, was: input.was, now: input.now },
    }
  }
  const hasA = args.trace_a !== undefined || args.source_a !== undefined
  const hasB = args.trace_b !== undefined || args.source_b !== undefined
  if (!hasA || !hasB) {
    throw new ToolError(
      'Give two runs: source_a and source_b, trace_a and trace_b, or source (or trace_id) with set',
    )
  }
  const a = context.traceOrSource(args, 'trace_a', 'source_a')
  const b = context.traceOrSource(args, 'trace_b', 'source_b')
  return { a, b, input: null }
}

/** The binding and literal text of `set`: an object `{name, value}` or `"NAME=VALUE"`. */
export function setting(given: unknown): { readonly name: string; readonly value: string } {
  if (typeof given === 'string') {
    const equals = given.indexOf('=')
    if (equals <= 0) throw new ToolError('set must look like NAME=VALUE')
    return { name: given.slice(0, equals).trim(), value: given.slice(equals + 1) }
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new ToolError('set must be {"name": …, "value": …} or "NAME=VALUE"')
  }
  const { name, value } = given as { name?: unknown; value?: unknown }
  if (typeof name !== 'string' || name === '') throw new ToolError('set.name must be a name')
  if (typeof value !== 'string') return { name, value: jsonLiteral(value, 'set.value') }
  // Literal text as is; anything that is not a literal (and not a list or record) is a text value.
  const probe = withInput('let v = nil\n', 'v', value)
  const looksStructured = /^\s*[[{]/.test(value)
  return { name, value: probe.ok || looksStructured ? value : formatLiteral(value) }
}

/** Each expectation judged in both runs, and whether B meets them all. */
function expectationsJson(sides: Sides, expectations: readonly Expectation[]): JsonObject {
  const inA = checkExpectations(sides.a.recording, expectations)
  const inB = checkExpectations(sides.b.recording, expectations)
  const rows = inB.map((b, i) => {
    const a = inA[i]!
    return {
      call: b.call,
      expected: b.expected,
      a: { recorded: a.recorded, verdict: a.verdict },
      b: { recorded: b.recorded, verdict: b.verdict },
    }
  })
  const met = inB.every((row) => row.verdict === 'right')
  const fixed = rows.filter((row) => row.a.verdict === 'wrong' && row.b.verdict === 'right').length
  const broken = rows.filter((row) => row.a.verdict === 'right' && row.b.verdict !== 'right').length
  return {
    expectations: rows,
    expectations_met_in_b: met,
    expectations_summary: `${fixed} fixed, ${broken} broken, ${inB.filter((row) => row.verdict === 'right').length} of ${rows.length} right in B`,
  }
}

function linesJson(lines: LineSpan | null): Json {
  return lines === null ? null : { start: lines.start, end: lines.end }
}

function callJson(call: DiffCall): JsonObject {
  return {
    function: call.depth === 0 ? '<top level>' : call.name,
    call: call.signature,
    did: call.did,
    first_step: call.entry,
    lines: linesJson(call.lines),
  }
}

function listJson<T>(list: DiffList<T>, render: (item: T) => Json): JsonObject {
  return {
    items: list.items.map(render),
    total: list.total,
    truncated: list.items.length < list.total,
  }
}

function unmatchedJson(call: UnmatchedCall): Json {
  return { ...callJson(call), calls_inside: call.calls - 1 }
}

function changedJson(change: ChangedCall): Json {
  return {
    function: change.a.depth === 0 ? '<top level>' : change.a.name,
    ...(change.renamed ? { renamed_to: change.b.name } : {}),
    changes: [...change.changes],
    inputs_changed: change.inputsChanged,
    a: callJson(change.a),
    b: callJson(change.b),
  }
}

function originJson(origin: OriginGroup): Json {
  return {
    function: origin.a.depth === 0 ? '<top level>' : origin.a.name,
    ...(origin.renamed ? { renamed_to: origin.b.name } : {}),
    lines_a: linesJson(origin.a.lines),
    lines_b: linesJson(origin.b.lines),
    reason: originReason(origin),
    changes: [...origin.changes],
    identical_calls: origin.count,
    a: callJson(origin.a),
    b: callJson(origin.b),
  }
}

function headline(diff: RunDiff, input: JsonObject | null): string {
  if (diff.same) return 'The runs behave the same: same outcome, same output, same calls.'
  const first = diff.origins.items[0]
  if (first === undefined) {
    return 'The runs differ, but no origin was found: every changed call was given different inputs (or the alignment budget ran out).'
  }
  const others =
    diff.origins.total > first.count ? `, and ${diff.origins.total - first.count} more` : ''
  if (first.a.depth === 0 && input !== null) {
    // The top-level code is where the input was changed: that is the origin, not a mistake there.
    return `The difference starts at the input: ${String(input.name)} = ${String(input.now)} on line ${String(input.line)} instead of ${String(input.was)}; the top-level code then makes its calls with other values${others === '' ? '' : ` (${diff.origins.total} origins)`}.`
  }
  const name = first.a.depth === 0 ? 'the top-level code' : first.a.name
  const lines = first.b.lines ?? first.a.lines
  const where = lines === null ? '' : ` (lines ${lines.start}–${lines.end} of B)`
  return `The difference starts in ${name}${where}: ${originReason(first)}${others}.`
}

function diffJson(sides: Sides, diff: RunDiff): JsonObject {
  const changedOutput = diff.output.lines.filter((line) => line.kind !== 'same')
  const run = (trace: Trace, summary: RunDiff['a']): JsonObject => ({
    trace_id: trace.id,
    steps: summary.steps,
    outcome: outcomeJson(trace.recording),
    output_lines: summary.outputs,
    calls: summary.calls,
  })
  return {
    summary: headline(diff, sides.input),
    same: diff.same,
    same_outcome: diff.sameOutcome,
    ...(sides.input === null ? {} : { input: sides.input }),
    a: run(sides.a, diff.a),
    b: run(sides.b, diff.b),
    output_lines_removed: diff.output.removed,
    output_lines_added: diff.output.added,
    output_diff: changedOutput
      .slice(0, MAX_OUTPUT_DIFF)
      .map((line) => `${line.kind === 'removed' ? '-' : '+'} ${line.text}`),
    output_diff_truncated: changedOutput.length > MAX_OUTPUT_DIFF,
    origins: listJson(diff.origins, originJson),
    only_in_a: listJson(diff.onlyA, unmatchedJson),
    only_in_b: listJson(diff.onlyB, unmatchedJson),
    renamed: diff.renamed.map((rename) => ({ from: rename.from, to: rename.to })),
    changed: listJson(diff.changed, changedJson),
    matched_calls: diff.matched,
    compared_calls: diff.compared,
    budget: {
      alignment_truncated: diff.truncated.nodes,
      comparison_truncated: diff.truncated.compared,
    },
    next_steps: diff.same
      ? ['The change did not alter behavior on this input; try another input with set.']
      : [
          "seek_state on trace a or b at an origin's first_step shows the state where the two runs part.",
          'query_provenance there explains where a differing value came from.',
          'Raise limit to list more entries (totals are always given).',
        ],
  }
}
