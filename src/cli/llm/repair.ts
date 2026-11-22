/**
 * LLM repair, verified by the VM (ARCHITECTURE §9.2): the model gets the culprit function and the
 * evidence (for a crash, the error, the stack and the slice; after an interview, the calls judged
 * right and wrong with what they should return when known) and proposes up to three rewrites of
 * the whole function. Each is checked by running the program (`repair-verify.ts`); verified ones
 * are printed as unified diffs with their behavior change, rejected ones with the reasons. When
 * none verifies, a second round sends the reasons back. Nothing is ever written here: applying a
 * candidate is the caller's explicit choice.
 */
import { callTree, errorSlice, LineIndex, type Recording } from '../../core/index'
import { type Style, sanitize } from '../format'
import { LANGUAGE_CHEAT_SHEET } from './cheatsheet'
import type { LlmClient } from './client'
import { helperSources } from './context'
import { unifiedDiff } from './line-diff'
import {
  type CandidateCheck,
  type Example,
  prepareExamples,
  type RepairGoal,
  type RepairTarget,
  repairTarget,
  verifyCandidate,
  type VerifyContext,
} from './repair-verify'
import type { LlmRequest } from './types'

export const MAX_CANDIDATES = 3
export const MAX_ROUNDS = 2
/** Slice lines shown for a crash. */
const MAX_SLICE_LINES = 40
/** Characters of a rejected candidate quoted back in the second round. */
const MAX_FEEDBACK_TEXT = 1_500

export const REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          function: { type: 'string', description: 'The whole rewritten function' },
          explanation: { type: 'string', description: 'One sentence' },
        },
        required: ['function', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
} as const

const SYSTEM = `You fix bugs in programs written in Hindsight, a small dynamically typed language. A deterministic debugger has shown that one function is at fault and gives you the evidence. Rewrite that whole function so the program does what it evidently means to do.

Keep the function's name and parameters (its callers must keep working), keep its contracts unless they are wrong themselves, change no more than the fix needs, and use only the language in the cheat sheet. Every candidate is compiled and run by the debugger and checked against the evidence, so a candidate that only hides the symptom (special-casing the inputs shown, returning a constant) is rejected.

Give up to ${MAX_CANDIDATES} candidates, each a different plausible fix, best first, as JSON: {"candidates": [{"function": "<the whole function, from fn to its closing brace>", "explanation": "<one sentence>"}]}.

${LANGUAGE_CHEAT_SHEET}`

export interface RepairCandidate {
  readonly round: number
  readonly explanation: string
  readonly check: CandidateCheck
  /** The unified diff against the original program (empty when it could not be spliced). */
  readonly diff: readonly string[]
}

export interface AiRepairResult {
  /** Why no repair was attempted (no crash, no function to rewrite). */
  readonly problem: string | null
  readonly target: RepairTarget | null
  readonly candidates: readonly RepairCandidate[]
  readonly rounds: number
  /** Why the model could not be asked (a failed request, the cap), if it could not. */
  readonly error: string | null
}

const fenced = (text: string) => `\`\`\`\n${text}\n\`\`\``

function numbered(index: LineIndex, line: number): string {
  return `${String(line).padStart(4)} | ${index.lineText(line)}`
}

function crashEvidence(recording: Recording): string[] {
  const { outcome, program } = recording
  if (outcome.kind !== 'error') return []
  const index = new LineIndex(program.source)
  const { error } = outcome
  const line = index.lineOf(error.span.start)
  const hint = error.hint === undefined ? '' : ` (hint: ${error.hint})`
  const frames = [...recording.stateAt(recording.length).frames]
    .reverse()
    .filter((frame) => !frame.library)
    .map((frame) => `${frame.name} (line ${frame.line})`)
  const parts = [
    `The error: ${error.code} ${error.message}${hint}\nat line ${line}: ${index.lineText(line).trim()}`,
    `Call stack, innermost first: ${frames.join(', ')}`,
  ]
  const slice = errorSlice(recording)
  if (slice !== null && slice.lines.size > 0) {
    const lines = [...slice.lines].sort((a, b) => a - b).slice(0, MAX_SLICE_LINES)
    parts.push(
      `The lines that led to the error (its backward slice):\n${lines.map((n) => numbered(index, n)).join('\n')}`,
    )
  }
  return parts
}

function exampleLines(examples: readonly Example[]): string[] {
  const right = examples.filter((example) => example.answer === 'right')
  const wrong = examples.filter((example) => example.answer === 'wrong')
  const parts: string[] = []
  if (right.length > 0) {
    const lines = right.map((e) => `  ${e.shown} returned ${e.beforeText}  (${e.by})`)
    parts.push(`Calls judged right (a fix must keep these results):\n${lines.join('\n')}`)
  }
  if (wrong.length > 0) {
    const lines = wrong.map((e) => {
      const should =
        e.expectedText === null
          ? 'it should return something else'
          : `it should return ${e.expectedText}`
      return `  ${e.shown} returned ${e.beforeText}; ${should}  (${e.by})`
    })
    parts.push(`Calls judged wrong:\n${lines.join('\n')}`)
  }
  return parts
}

/** The first prompt: the function and the evidence. */
export function repairPrompt(
  recording: Recording,
  target: RepairTarget,
  goal: RepairGoal,
  examples: readonly Example[],
): string {
  const where = `lines ${target.lines.start}–${target.lines.end} of the program`
  const head =
    goal.kind === 'crash'
      ? `The program crashed in the function ${target.name}.`
      : `Questions about the program's calls isolated a bug in the function ${target.name}: its own code is at fault.`
  const parts = [head, `The function (${where}):\n${fenced(target.text)}`]
  if (goal.kind === 'crash') {
    parts.push(...crashEvidence(recording))
    parts.push(
      `Rewrite ${target.name} so that the run finishes without an error and does what the program evidently means.`,
    )
  } else {
    const wrongCall = goal.judgments.find(
      (judgment) => judgment.answer === 'wrong' && judgment.call.protoId === target.protoId,
    )
    const tree = callTree(recording)
    const helpers = wrongCall === undefined ? [] : helperSources(tree, wrongCall.call)
    if (helpers.length > 0) parts.push(`Functions it calls:\n${fenced(helpers.join('\n\n'))}`)
    parts.push(...exampleLines(examples))
    parts.push(
      `Rewrite ${target.name} so that every call judged wrong returns what it should while the calls judged right keep their results.`,
    )
  }
  return parts.join('\n\n')
}

/** Rejected candidates and their reasons, for the second round. */
function feedback(rejected: readonly { text: string; reasons: readonly string[] }[]): string {
  const items = rejected.map((candidate, i) => {
    const text =
      candidate.text.length > MAX_FEEDBACK_TEXT
        ? `${candidate.text.slice(0, MAX_FEEDBACK_TEXT)}\n// … cut`
        : candidate.text
    return `Candidate ${i + 1}:\n${fenced(text)}\nRejected: ${candidate.reasons.join('; ')}`
  })
  return `Your earlier candidates were all rejected when the debugger ran them:\n\n${items.join('\n\n')}\n\nTry again, avoiding these problems.`
}

interface Proposal {
  readonly text: string
  readonly explanation: string
}

function readProposals(json: Readonly<Record<string, unknown>>): Proposal[] {
  const list = json.candidates
  if (!Array.isArray(list)) return []
  const proposals: Proposal[] = []
  for (const item of list) {
    if (proposals.length >= MAX_CANDIDATES) break
    if (item === null || typeof item !== 'object') continue
    const { function: text, explanation } = item as { function?: unknown; explanation?: unknown }
    if (typeof text !== 'string' || text.trim() === '') continue
    proposals.push({ text, explanation: typeof explanation === 'string' ? explanation.trim() : '' })
  }
  return proposals
}

function request(prompt: string): LlmRequest {
  return { system: SYSTEM, prompt, schema: REPAIR_SCHEMA, effort: 'high', maxTokens: 32_000 }
}

/** Asks for rewrites of the goal's function and checks each one; at most two rounds. */
export async function aiRepair(
  client: LlmClient,
  recording: Recording,
  goal: RepairGoal,
  options: { readonly seed: number },
): Promise<AiRepairResult> {
  const target = repairTarget(recording, goal)
  if (typeof target === 'string')
    return { problem: target, target: null, candidates: [], rounds: 0, error: null }
  const examples = goal.kind === 'examples' ? prepareExamples(recording, goal.judgments) : []
  if (goal.kind === 'examples' && !examples.some((example) => example.answer === 'wrong')) {
    const problem = 'No call was judged wrong: there is nothing to check a repair against.'
    return { problem, target, candidates: [], rounds: 0, error: null }
  }
  const context: VerifyContext = { recording, target, goal, examples, seed: options.seed }
  const first = repairPrompt(recording, target, goal, examples)
  const candidates: RepairCandidate[] = []
  let prompt = first
  let error: string | null = null
  let rounds = 0
  while (rounds < MAX_ROUNDS) {
    if (client.exhausted) {
      error = `the cap of ${client.config.maxCalls} requests is reached (--llm-max-calls)`
      break
    }
    rounds += 1
    const reply = await client.completeJson(request(prompt))
    if (!reply.ok) {
      error = reply.error
      break
    }
    const proposals = readProposals(reply.json)
    if (proposals.length === 0) {
      error = 'the answer held no candidate'
      break
    }
    const checked = proposals.map((proposal) => ({
      proposal,
      check: verifyCandidate(context, proposal.text),
    }))
    for (const { proposal, check } of checked) {
      const diff = check.source === null ? [] : unifiedDiff(recording.program.source, check.source)
      candidates.push({ round: rounds, explanation: proposal.explanation, check, diff })
    }
    if (checked.some(({ check }) => check.verified)) break
    prompt = `${first}\n\n${feedback(
      checked.map(({ proposal, check }) => ({
        text: proposal.text.trim(),
        reasons: check.verified ? [] : check.reasons,
      })),
    )}`
  }
  return { problem: null, target, candidates, rounds, error }
}

/** The verified programs, in the order the report numbers them. */
export function verifiedSources(result: AiRepairResult): string[] {
  return result.candidates.flatMap((candidate) =>
    candidate.check.verified ? [candidate.check.source] : [],
  )
}

/** The result as lines: verified candidates numbered, with diffs; rejected ones with reasons. */
export function repairReport(result: AiRepairResult, style: Style, model: string): string[] {
  if (result.problem !== null)
    return [`${style.error('no AI repair')}: ${sanitize(result.problem)}`]
  const target = result.target!
  const lines = [
    '',
    style.bold(
      `AI repair of ${sanitize(target.name)} (lines ${target.lines.start}–${target.lines.end}) by ${sanitize(model)}, each candidate checked by the VM:`,
    ),
  ]
  let number = 0
  for (const candidate of result.candidates) {
    const about = candidate.explanation === '' ? '' : `: ${sanitize(candidate.explanation)}`
    const round = candidate.round > 1 ? style.dim(` (round ${candidate.round})`) : ''
    if (candidate.check.verified) {
      number += 1
      lines.push(`${style.ok('✓')} ${style.bold(`Candidate ${number}`)}${round}${about}`)
      for (const line of candidate.diff) lines.push(`    ${diffStyle(style, sanitize(line))}`)
      for (const note of candidate.check.notes) lines.push(style.dim(`    ${sanitize(note)}`))
    } else {
      lines.push(`${style.error('✗')} rejected${round}${about}`)
      for (const reason of candidate.check.reasons)
        lines.push(style.dim(`    - ${sanitize(reason)}`))
    }
  }
  if (result.error !== null) lines.push(`${style.error('stopped')}: ${sanitize(result.error)}`)
  const total = result.candidates.length
  lines.push(
    style.dim(
      `${number} of ${total} ${total === 1 ? 'candidate' : 'candidates'} verified in ${result.rounds} ${result.rounds === 1 ? 'round' : 'rounds'}`,
    ),
  )
  return lines
}

function diffStyle(style: Style, line: string): string {
  if (line.startsWith('+')) return style.ok(line)
  if (line.startsWith('-')) return style.error(line)
  return line.startsWith('@@') ? style.dim(line) : line
}
