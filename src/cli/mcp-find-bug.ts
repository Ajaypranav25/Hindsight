/**
 * The `find_bug` tool (ARCHITECTURE §7.6, §9.1): the bug finder as a stateless interview. The
 * agent passes every answer given so far; each call rebuilds the finder from the start, replays
 * the answers, and returns the next open question or the verdict with repair previews. A question
 * id is derived from the call's memoization key (`average#3f2a91c0`), so it is stable across calls
 * and identical calls share it. An oracle (`(details) => answer | null`) can answer questions
 * automatically, for example from contracts or assertions; the tool itself plugs none in.
 */
import {
  answer,
  type Answer,
  type CallDetails,
  type CallNode,
  type CallTree,
  callTree,
  culpritText,
  type FinderState,
  question,
  remaining,
  repairExamples,
  startFinder,
  type Strategy,
  verdict,
  verdictReason,
} from '../core/index'
import { searchRepairs } from './lab'
import { MUTANTS, REPAIRS, repairsJson } from './mcp-repair'
import {
  type Args,
  callJson,
  choiceArg,
  integerArg,
  type Json,
  type JsonObject,
  MAX_STEPS,
  schema,
  SEED,
  SOURCE,
  sourceLine,
  type Tool,
  type ToolContext,
  ToolError,
  TRACE_ID,
} from './mcp-shared'

export const MAX_ANSWERS = 1000
const ANSWERS: readonly Answer[] = ['right', 'wrong', 'unsure']
const MAX_CODE_LINES = 30

/** Answers a question automatically, or returns null to leave it to the agent. */
export type Oracle = (details: CallDetails) => Answer | null

export interface InterviewOptions {
  readonly strategy?: Strategy
  readonly oracle?: Oracle
}

export interface AutoAnswer {
  readonly question: string
  readonly answer: Answer
}

export interface Interview {
  readonly state: FinderState
  /** The open question; null once there is a verdict. */
  readonly open: CallNode | null
  /** Ids of the given answers the interview used. */
  readonly used: ReadonlySet<string>
  /** Questions the oracle answered, in order. */
  readonly auto: readonly AutoAnswer[]
}

/** FNV-1a, 32 bits, as 8 hex digits: a short, deterministic digest of a memo key. */
function digest(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The stable id of a question about `call`: equal for identical calls. */
export function questionId(tree: CallTree, call: CallNode): string {
  const key = tree.keyOf(call)
  const name = call.depth === 0 ? 'top' : call.name
  return key === null ? `${name}@${call.entry}` : `${name}#${digest(key)}`
}

/**
 * Starts the finder at the root and replays `answers` (by question id) and the oracle's answers,
 * stopping at the first question neither can answer. Each answer moves the search one call down
 * or clears a subtree, so the loop ends after at most one answer per call.
 */
export function replayInterview(
  tree: CallTree,
  answers: ReadonlyMap<string, Answer>,
  options: InterviewOptions = {},
): Interview {
  let state = startFinder(tree, tree.root, {
    justMyCode: true,
    strategy: options.strategy ?? 'divide',
  })
  const used = new Set<string>()
  const auto: AutoAnswer[] = []
  for (;;) {
    const call = question(state)
    if (call === null) return { state, open: null, used, auto }
    const id = questionId(tree, call)
    const given = answers.get(id)
    if (given !== undefined) {
      used.add(id)
      state = answer(state, given)
      continue
    }
    const automatic = options.oracle?.(tree.details(call)) ?? null
    if (automatic === null) return { state, open: call, used, auto }
    auto.push({ question: id, answer: automatic })
    state = answer(state, automatic)
  }
}

export function findBugTool(context: ToolContext): Tool {
  return {
    name: 'find_bug',
    description:
      'Localize a wrong result without reading every function: an interview (algorithmic debugging) about recorded calls. Each call returns either the next question (a call with its arguments, result and side effects: is that what the function should do?) or the verdict (the function whose own code is wrong, its lines, certainty) with verified one-token repair previews that agree with your answers. STATELESS: pass trace_id (or source) and every answer so far as answers: [{"question": "<id from the question>", "answer": "right" | "wrong" | "unsure"}]. strategy "divide" (default) halves the suspects with each answer (about log2(calls) questions); "top-down" asks in execution order.',
    inputSchema: schema(
      {
        trace_id: TRACE_ID,
        source: SOURCE,
        max_steps: MAX_STEPS,
        seed: SEED,
        answers: {
          type: 'array',
          description: 'Every answer given so far, in any order',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The id of a question' },
              answer: { type: 'string', enum: [...ANSWERS] },
            },
            required: ['question', 'answer'],
          },
        },
        strategy: { type: 'string', enum: ['divide', 'top-down'], description: 'Default divide' },
        max_mutants: MUTANTS,
        max_repairs: REPAIRS,
      },
      [],
    ),
    run: (args) => findBug(context, args),
  }
}

function parseAnswers(given: unknown): Map<string, Answer> {
  const answers = new Map<string, Answer>()
  if (given === undefined || given === null) return answers
  if (!Array.isArray(given)) throw new ToolError('answers must be an array')
  if (given.length > MAX_ANSWERS) throw new ToolError(`at most ${MAX_ANSWERS} answers`)
  given.forEach((item: unknown, index) => {
    const entry = (item ?? {}) as { question?: unknown; answer?: unknown }
    if (typeof entry.question !== 'string') {
      throw new ToolError(`answer ${index + 1} needs question (the id of a question)`)
    }
    if (
      typeof entry.answer !== 'string' ||
      !(ANSWERS as readonly string[]).includes(entry.answer)
    ) {
      throw new ToolError(`answer ${index + 1} must be "right", "wrong" or "unsure"`)
    }
    answers.set(entry.question, entry.answer as Answer)
  })
  return answers
}

function findBug(context: ToolContext, args: Args): Json {
  const trace = context.traceOrSource(args, 'trace_id', 'source')
  const strategy = choiceArg(args, 'strategy', ['divide', 'top-down'] as const, 'divide')
  const answers = parseAnswers(args.answers)
  const tree = callTree(trace.recording)
  const interview = replayInterview(tree, answers, { strategy })
  const unused = [...answers.keys()].filter((id) => !interview.used.has(id))
  const base: JsonObject = {
    trace_id: trace.id,
    strategy,
    questions_answered: interview.used.size + interview.auto.length,
    ...(unused.length > 0
      ? {
          unused_answers: unused.slice(0, 50),
          unused_note:
            'These ids were not asked in this interview (another trace, or an answer made them moot); they were ignored.',
        }
      : {}),
    ...(trace.recording.outcome.kind === 'error'
      ? { note: 'The run crashed: diagnose_failure is usually the faster start.' }
      : {}),
  }
  if (interview.open !== null) return openQuestion(tree, interview, base)
  return verdictJson(tree, trace.source, interview.state, base, args)
}

function openQuestion(tree: CallTree, interview: Interview, base: JsonObject): Json {
  const call = interview.open!
  const id = questionId(tree, call)
  return {
    ...base,
    status: 'question',
    question: { id, ...callJson(tree.details(call)) },
    suspects_remaining: remaining(interview.state),
    how_to_answer: `Is this what ${call.name} should do for these arguments (its result and side effects)? Call find_bug again with the same trace_id and strategy, and answers plus {"question": "${id}", "answer": "right" | "wrong" | "unsure"}.`,
  }
}

function verdictJson(
  tree: CallTree,
  source: string,
  state: FinderState,
  base: JsonObject,
  args: Args,
): Json {
  const found = verdict(state)
  if (found.kind !== 'found') throw new ToolError('The interview ended without a verdict')
  const details = tree.details(found.call)
  const calls = tree.children(found.call, { justMyCode: state.justMyCode }).length
  const code: Json[] = []
  if (details.lines !== null) {
    const last = Math.min(details.lines.end, details.lines.start + MAX_CODE_LINES - 1)
    for (let line = details.lines.start; line <= last; line++) {
      code.push({ line, text: sourceLine(source, line) })
    }
  }
  const repairs = searchRepairs(
    tree.recording,
    { kind: 'examples', protoId: found.call.protoId, examples: repairExamples(tree, state) },
    {
      maxMutants: integerArg(args, 'max_mutants', 150, 1, 400),
      maxRepairs: integerArg(args, 'max_repairs', 5, 1, 10),
    },
  )
  return {
    ...base,
    status: 'verdict',
    verdict: {
      function: found.call.depth === 0 ? '<top level>' : found.call.name,
      where: culpritText(details),
      lines: details.lines === null ? null : { start: details.lines.start, end: details.lines.end },
      certainty: found.certainty,
      reason: verdictReason(details, found.certainty, calls),
      call: callJson(details),
      code,
    },
    repairs: repairsJson(repairs),
    next_steps: [
      'Check each repair\'s "now" against what you expect; a repair is only a preview.',
      'diff_runs with the old and the patched source confirms the fix changes only what it should.',
    ],
  }
}
