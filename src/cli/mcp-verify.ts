/**
 * The `verify_patch` tool (ARCHITECTURE §9.1): an agent's own fix, checked by the VM. The original
 * (a trace or a source) and the patched program are both recorded and compared: does the patch
 * compile, does the crash go away, do the expectations (as for suggest_repairs) now hold, does a
 * contract or assertion fail, and what changed call by call (`diffRuns`). The verdict is one of
 * fixed, improved, unchanged, regressed or does-not-compile, each with its reasons, so an agent
 * never has to take its own patch on faith. The server itself never calls a model: agents bring
 * the patch, the VM is the judge.
 */
import { diffRuns, LineIndex, type Recording } from '../core/index'
import { diffJson, expectationsJson, type Sides } from './mcp-diff'
import { EXPECTATIONS, parseExpectations } from './mcp-repair'
import {
  type Args,
  clampedArg,
  type Json,
  type JsonObject,
  MAX_STEPS,
  outcomeJson,
  schema,
  SEED,
  SOURCE,
  type Tool,
  type ToolContext,
  ToolError,
  type Trace,
  TRACE_ID,
} from './mcp-shared'

export const VERIFY_DEFAULT_LIMIT = 10
export const VERIFY_MAX_LIMIT = 100

export type PatchVerdict = 'fixed' | 'improved' | 'unchanged' | 'regressed' | 'does-not-compile'

/** Runtime errors that are a broken promise: an assertion, a precondition, a postcondition. */
const CHECKS: ReadonlyMap<string, string> = new Map([
  ['R018', 'assertion'],
  ['R026', 'precondition'],
  ['R027', 'postcondition'],
])

export function verifyPatchTool(context: ToolContext): Tool {
  return {
    name: 'verify_patch',
    description:
      'Checks a patch you wrote, by running it: give the original (trace_id or source) and patched_source (the whole patched program), optionally expectations in the suggest_repairs format ([{"call": "average([92, 88, 95])", "expected": "91.66666666666667"}]). Both runs are recorded and compared call by call. Returns compile errors (if any), both outcomes, whether a crash was fixed, each expectation judged in both runs, contract and assertion failures, a diff_runs summary (where the difference starts, changed calls, output diff) and a verdict: fixed, improved, unchanged, regressed or does-not-compile, with reasons. The patched run is kept as a trace (patched.trace_id) for the other tools. Pass the seed the original was recorded with if the program uses random numbers.',
    inputSchema: schema(
      {
        trace_id: TRACE_ID,
        source: { ...SOURCE, description: 'The original program (.sight text), if no trace_id' },
        patched_source: { type: 'string', description: 'The whole patched program (.sight text)' },
        expectations: {
          ...EXPECTATIONS,
          description:
            'What some calls should return: each is judged in both runs (right, wrong or unmatched)',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: VERIFY_MAX_LIMIT,
          description: `Diff entries listed per category (default ${VERIFY_DEFAULT_LIMIT}); totals are always given`,
        },
        max_steps: MAX_STEPS,
        seed: SEED,
      },
      ['patched_source'],
    ),
    run: (args) => verifyPatch(context, args),
  }
}

/** How a run ended badly, or null when it finished. */
export interface RunFailure {
  readonly kind: 'error' | 'step-limit' | 'aborted'
  /** A sentence: "crashes with R007 (index 2 is out of range) on line 2". */
  readonly text: string
  /** Error code and line, to tell two failures apart. */
  readonly key: string
}

export function failureOf(recording: Recording): RunFailure | null {
  const { outcome } = recording
  switch (outcome.kind) {
    case 'finished':
      return null
    case 'error': {
      const { error } = outcome
      const line = new LineIndex(recording.program.source).lineOf(error.span.start)
      const check = CHECKS.get(error.code)
      const what =
        check === undefined ? 'crashes' : `fails a${check === 'assertion' ? 'n' : ''} ${check}`
      return {
        kind: 'error',
        text: `${what} with ${error.code} (${error.message}) on line ${line}`,
        key: `${error.code}:${line}`,
      }
    }
    case 'step-limit':
      return {
        kind: 'step-limit',
        text: `hits the step limit of ${outcome.maxSteps.toLocaleString('en-US')} steps`,
        key: 'step-limit',
      }
    case 'aborted':
      return { kind: 'aborted', text: 'was stopped before the end', key: 'aborted' }
  }
}

/** The contract or assertion a run failed, or null. */
function checkJson(recording: Recording): Json {
  const { outcome } = recording
  if (outcome.kind !== 'error') return null
  const check = CHECKS.get(outcome.error.code)
  if (check === undefined) return null
  const line = new LineIndex(recording.program.source).lineOf(outcome.error.span.start)
  return { kind: check, code: outcome.error.code, message: outcome.error.message, line }
}

interface ExpectationRow {
  readonly call: string
  readonly expected: string
  readonly a: { readonly recorded: string | null; readonly verdict: string }
  readonly b: { readonly recorded: string | null; readonly verdict: string }
}

export interface Assessment {
  readonly verdict: Exclude<PatchVerdict, 'does-not-compile'>
  readonly reasons: readonly string[]
}

/**
 * Weighs the evidence: problems the patch removed (a failure, a wrong expectation), problems it
 * introduced, and problems that remain. Any new problem is a regression; all old ones gone with
 * nothing new is a fix; some gone is an improvement; otherwise the patch changed nothing known.
 */
export function assess(
  original: Recording,
  patched: Recording,
  rows: readonly ExpectationRow[],
  behaviorChanged: boolean,
): Assessment {
  const fixes: string[] = []
  const regressions: string[] = []
  const remaining: string[] = []
  const a = failureOf(original)
  const b = failureOf(patched)
  if (a === null && b !== null) regressions.push(`the patched run ${b.text}; the original finished`)
  if (a !== null && b === null) fixes.push(`the original ${a.text}; the patched run finishes`)
  if (a !== null && b !== null) {
    remaining.push(
      a.key === b.key
        ? `the patched run still ${b.text}`
        : `the original ${a.text}; the patched run ${b.text}`,
    )
  }
  for (const row of rows) {
    const now = row.b.recorded ?? 'no such call'
    if (row.a.verdict === 'right' && row.b.verdict !== 'right') {
      regressions.push(`${row.call} was right (${row.a.recorded ?? row.expected}); now ${now}`)
    } else if (row.a.verdict !== 'right' && row.b.verdict === 'right') {
      fixes.push(`${row.call} now returns ${row.expected}`)
    } else if (row.b.verdict !== 'right') {
      remaining.push(`${row.call} should return ${row.expected}; the patched run gives ${now}`)
    }
  }
  const reasons = [...regressions, ...fixes, ...remaining]
  if (regressions.length > 0) return { verdict: 'regressed', reasons }
  if (fixes.length > 0) return { verdict: remaining.length === 0 ? 'fixed' : 'improved', reasons }
  if (remaining.length > 0) return { verdict: 'unchanged', reasons }
  const quiet = behaviorChanged
    ? 'Neither run fails and nothing judges the change: the behavior differs (see diff); give expectations to judge it.'
    : 'Neither run fails, and both behave the same: same outcome, output and calls.'
  return { verdict: 'unchanged', reasons: [quiet] }
}

function runJson(trace: Trace): JsonObject {
  const { recording } = trace
  return {
    trace_id: trace.id,
    steps: recording.length,
    outcome: outcomeJson(recording),
    output_lines: recording.outputs.length,
  }
}

const NEXT_STEPS: Readonly<Record<PatchVerdict, readonly string[]>> = {
  fixed: [
    'The patch removes every problem the evidence shows; check the diff for changes you did not intend.',
    'Add expectations for other calls (or run find_bug on the patched trace) to cover behavior the evidence does not.',
  ],
  improved: [
    'Some problems remain (see reasons): diagnose_failure or find_bug on the patched trace shows where.',
  ],
  unchanged: [
    'If the run should behave differently, give expectations so the change can be judged.',
    "diff_runs and seek_state on the patched trace show what the patch does at an origin's first_step.",
  ],
  regressed: [
    "seek_state on the patched trace at an origin's first_step shows where the runs part.",
    'diagnose_failure on the patched trace explains a new crash.',
  ],
  'does-not-compile': [
    'Fix the compile errors (line and column above) and call verify_patch again.',
  ],
}

function verifyPatch(context: ToolContext, args: Args): Json {
  const original = context.traceOrSource(args, 'trace_id', 'source')
  if (typeof args.patched_source !== 'string') {
    throw new ToolError('patched_source must be a string: the whole patched program')
  }
  const expectations = args.expectations === undefined ? null : parseExpectations(args.expectations)
  const recorded = context.recordSource(args.patched_source, args)
  if (!recorded.ok) {
    return {
      verdict: 'does-not-compile',
      reasons: ['The patched program does not compile.'],
      compile_errors: recorded.failure.diagnostics ?? [],
      original: runJson(original),
      next_steps: [...NEXT_STEPS['does-not-compile']],
    }
  }
  const patched = recorded.trace
  const sides: Sides = { a: original, b: patched, input: null }
  const limit = clampedArg(args, 'limit', VERIFY_DEFAULT_LIMIT, 1, VERIFY_MAX_LIMIT)
  const diff = diffRuns(original.recording, patched.recording, { limit })
  const judged = expectations === null ? null : expectationsJson(sides, expectations)
  const rows = (judged?.expectations ?? []) as unknown as ExpectationRow[]
  const assessment = assess(original.recording, patched.recording, rows, !diff.same)
  const reasons =
    patched.source === original.source
      ? ['The patched program is the same text as the original.', ...assessment.reasons]
      : assessment.reasons
  const full = diffJson(sides, diff)
  const failedBefore = failureOf(original.recording)
  return {
    verdict: assessment.verdict,
    reasons: [...reasons],
    original: runJson(original),
    patched: runJson(patched),
    crash_fixed:
      failedBefore !== null &&
      failedBefore.kind === 'error' &&
      patched.recording.outcome.kind === 'finished',
    contract_failures: {
      original: checkJson(original.recording),
      patched: checkJson(patched.recording),
    },
    ...(judged ?? {}),
    diff: {
      note: 'a is the original run, b the patched one',
      summary: full.summary!,
      same: full.same!,
      same_outcome: full.same_outcome!,
      output_lines_removed: full.output_lines_removed!,
      output_lines_added: full.output_lines_added!,
      output_diff: full.output_diff!,
      output_diff_truncated: full.output_diff_truncated!,
      origins: full.origins!,
      changed: full.changed!,
      only_in_a: full.only_in_a!,
      only_in_b: full.only_in_b!,
      matched_calls: full.matched_calls!,
    },
    next_steps: [...NEXT_STEPS[assessment.verdict]],
  }
}
