/**
 * The `query` tool (ARCHITECTURE §7.9, §9.1) with budgets for an agent's context window: matches
 * come in pages (`offset`, `limit`), and `summary: true` groups them by line and function (counts,
 * first and last step, the range of numeric values) and collapses runs of consecutive matches on
 * one line into one row ("line 12 ×1,000, steps 410–9,410") instead of listing every iteration.
 */
import { queryRecording, type QueryResult, type Recording, writeName } from '../core/index'
import {
  type Args,
  booleanArg,
  clampedArg,
  eventJson,
  integerArg,
  type Json,
  type JsonObject,
  lineOf,
  page,
  schema,
  stringArg,
  type Tool,
  type ToolContext,
  ToolError,
  TRACE_ID,
} from './mcp-shared'

export const QUERY_DEFAULT_LIMIT = 50
export const QUERY_MAX_LIMIT = 500
/** The most matches one query collects, to page past them or to summarize them. */
export const QUERY_CAP = 100_000

const count = (n: number) => n.toLocaleString('en-US')

export function queryTool(context: ToolContext): Tool {
  return {
    name: 'query',
    description:
      'Find moments by condition instead of stepping. Forms: `when x > 3 and depth > 1` (the stretches of steps where it held), `changed(order.paid)` (every write, following the object across functions), `calls(fib) where ret < 0` (calls filtered by arguments and result). Expressions read the program variables plus depth, step, line, function. Results come in pages (offset, limit: default 50, max 500); use summary: true first on loops: it groups matches by line and function with counts, step ranges and value ranges, and collapses repeats into rows like "line 12 ×1,000, steps 410–9,410".',
    inputSchema: schema(
      {
        trace_id: TRACE_ID,
        query: { type: 'string', description: 'when …, changed(…) or calls(…) [where …]' },
        offset: { type: 'integer', minimum: 0, description: 'Matches to skip (default 0)' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: QUERY_MAX_LIMIT,
          description: `Matches (or summary rows) per page (default ${QUERY_DEFAULT_LIMIT})`,
        },
        summary: {
          type: 'boolean',
          description: 'Group and collapse matches instead of listing them (default false)',
        },
      },
      ['trace_id', 'query'],
    ),
    run: (args) => runQueryTool(context, args),
  }
}

function runQueryTool(context: ToolContext, args: Args): Json {
  const trace = context.trace(args)
  const text = stringArg(args, 'query')
  if (text === null) throw new ToolError('query must be a string')
  const offset = integerArg(args, 'offset', 0, 0, QUERY_CAP)
  const limit = clampedArg(args, 'limit', QUERY_DEFAULT_LIMIT, 1, QUERY_MAX_LIMIT)
  const summary = booleanArg(args, 'summary', false)
  // `changed` samples a binding's history evenly once it is cut, so its pages need every event.
  const sampled = /^\s*changed\s*\(/.test(text)
  const wanted = summary || sampled ? QUERY_CAP : Math.min(QUERY_CAP, offset + limit)
  const outcome = queryRecording(trace.recording, text, { limit: wanted })
  if (!outcome.ok) throw new ToolError(outcome.error)
  const { recording } = trace
  return summary
    ? summaryJson(recording, outcome.result, offset, limit)
    : listJson(recording, outcome.result, offset, limit)
}

function moreHint(next: number | null): Json {
  return next === null
    ? null
    : `call query again with offset: ${next}, or with summary: true to see the matches grouped`
}

function listJson(recording: Recording, result: QueryResult, offset: number, limit: number): Json {
  const paging = (shown: number, collected: number, capped: boolean): JsonObject => {
    const end = offset + shown
    const next = end < collected || capped ? end : null
    return { offset, limit, truncated: next !== null, next_offset: next, more: moreHint(next) }
  }
  switch (result.kind) {
    case 'when': {
      const shown = page(result.intervals, offset, limit)
      return {
        kind: 'when',
        matches: result.matches,
        intervals: shown.items.map((interval) => ({
          from: interval.from,
          to: interval.to,
          line: lineOf(recording, interval.from),
        })),
        ...paging(shown.items.length, result.intervals.length, result.truncated),
      }
    }
    case 'changed': {
      const shown = page(result.events, offset, limit)
      return {
        kind: 'changed',
        total: result.total,
        events: shown.items.map((event) => eventJson(recording, event)),
        ...paging(shown.items.length, result.events.length, result.truncated),
      }
    }
    case 'calls': {
      const shown = page(result.calls, offset, limit)
      return {
        kind: 'calls',
        total: result.total,
        calls: shown.items.map((call) => ({ ...call })),
        ...paging(shown.items.length, result.calls.length, result.truncated),
      }
    }
  }
}

// --- summaries ----------------------------------------------------------------------------------

/** One match, reduced to what a summary groups by. */
interface Match {
  readonly step: number
  readonly last: number
  readonly line: number | null
  readonly function: string
  readonly name: string | null
  readonly value: number | null
}

interface Row {
  readonly line: number | null
  readonly function: string
  readonly name: string | null
  count: number
  first: number
  last: number
  min: number | null
  max: number | null
}

const RETURNED_NUMBER = / returned (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/

function functionAt(recording: Recording, time: number): string {
  return recording.locationAt(Math.min(time, recording.length))?.functionName ?? '(the end)'
}

function matchesOf(recording: Recording, result: QueryResult): Match[] {
  switch (result.kind) {
    case 'when':
      return result.intervals.map((interval) => ({
        step: interval.from,
        last: interval.to,
        line: lineOf(recording, interval.from),
        function: functionAt(recording, interval.from),
        name: null,
        value: null,
      }))
    case 'changed':
      return result.events.map((event) => ({
        step: event.time,
        last: event.time,
        line: lineOf(recording, event.time),
        function: functionAt(recording, event.time),
        name: writeName(recording, event),
        value: typeof event.value === 'number' ? event.value : null,
      }))
    case 'calls':
      // Grouped by call site: the line and function of the instruction that made the call.
      return result.calls.map((call) => {
        const returned = RETURNED_NUMBER.exec(call.text)
        return {
          step: call.entry,
          last: call.exit,
          line: lineOf(recording, call.entry - 1),
          function: functionAt(recording, call.entry - 1),
          name: null,
          value: returned === null ? null : Number(returned[1]),
        }
      })
  }
}

function add(row: Row, match: Match): void {
  row.count += 1
  row.last = Math.max(row.last, match.last)
  if (match.value !== null) {
    row.min = row.min === null ? match.value : Math.min(row.min, match.value)
    row.max = row.max === null ? match.value : Math.max(row.max, match.value)
  }
}

function newRow(match: Match): Row {
  const row: Row = {
    line: match.line,
    function: match.function,
    name: match.name,
    count: 0,
    first: match.step,
    last: match.last,
    min: null,
    max: null,
  }
  add(row, match)
  return row
}

function rowText(row: Row): string {
  const where = `${row.name === null ? '' : `${row.name}: `}line ${row.line ?? '(library)'}`
  const times = row.count === 1 ? '' : ` ×${count(row.count)}`
  const steps =
    row.first === row.last
      ? `step ${count(row.first)}`
      : `steps ${count(row.first)}–${count(row.last)}`
  const values =
    row.min === null || row.max === null
      ? ''
      : row.min === row.max
        ? `, value ${row.min}`
        : `, values ${row.min}–${row.max}`
  return `${where}${times}, ${steps}${values}`
}

function rowJson(row: Row): JsonObject {
  return {
    text: rowText(row),
    line: row.line,
    function: row.function,
    ...(row.name === null ? {} : { name: row.name }),
    count: row.count,
    first_step: row.first,
    last_step: row.last,
    ...(row.min === null ? {} : { min: row.min, max: row.max }),
  }
}

function summaryJson(
  recording: Recording,
  result: QueryResult,
  offset: number,
  limit: number,
): Json {
  const matches = matchesOf(recording, result)
  const groups = new Map<string, Row>()
  const runs: Row[] = []
  for (const match of matches) {
    const key = `${match.line}\u0000${match.function}\u0000${match.name}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, newRow(match))
    else add(group, match)
    const previous = runs.at(-1)
    const sameRun =
      previous !== undefined &&
      previous.line === match.line &&
      previous.function === match.function &&
      previous.name === match.name
    if (sameRun) add(previous, match)
    else runs.push(newRow(match))
  }
  const shownRuns = page(runs, offset, limit)
  const groupList = [...groups.values()]
  return {
    kind: result.kind,
    summary: true,
    matches: matches.length,
    ...(result.kind === 'when' ? { statements_matched: result.matches } : {}),
    capped: result.truncated,
    groups: groupList.slice(0, limit).map(rowJson),
    groups_total: groupList.length,
    rows: shownRuns.items.map(rowJson),
    rows_total: runs.length,
    offset,
    limit,
    truncated: shownRuns.next !== null || groupList.length > limit || result.truncated,
    next_offset: shownRuns.next,
    more:
      shownRuns.next === null
        ? null
        : `call query again with summary: true and offset: ${shownRuns.next} for more rows`,
  }
}
