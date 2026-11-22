/**
 * `hindsight debug FILE` (ARCHITECTURE §7.6, §9): the bug finder as an interview on stdin and
 * stdout. Each question shows a recorded call and what it returned; answers arrive one per line
 * (r, w, n or ?, u, q), from a terminal or from a pipe, so an interview can be scripted. It ends
 * with the verdict and the buggy function's code.
 *
 * Contracts and assertions answer what they can (`contractOracle`, unless --no-auto); each such
 * answer is printed with its evidence. With --llm a model is consulted next (an advisor, ARCHITECTURE
 * §9.2): the session then waits (`settle`) while it is asked, and its answers go through the same
 * automatic-answer path, so they are printed with their evidence and taken back with undo. With
 * --no-ask nobody else is asked: the interview stops at the first question they cannot answer, with
 * exit code 3. After a verdict, with --llm, the session offers a model's repair of the culprit.
 */
import {
  answer,
  type Answer,
  answerAssertions,
  autoAnswer,
  type AutoAnswer,
  type CallNode,
  type CallOracle,
  callSignature,
  type CallDetails,
  type CallTree,
  callTree,
  changeTexts,
  contractOracle,
  culpritText,
  type FinderState,
  LineIndex,
  type LineSpan,
  linesText,
  outcomeText,
  question,
  record,
  type Recording,
  remaining,
  repairExamples,
  startFinder,
  type Strategy,
  undo,
  verdict,
  verdictReason,
} from '../core/index'
import type { Command } from './args'
import { type ExitCode, load, type Loaded } from './commands'
import { formatRuntimeError, makeStyle, sanitize, type Style } from './format'
import type { CliIO } from './io'
import { repairLines, searchRepairs } from './lab'
import type { Consultation } from './llm/oracle'
import type { RepairJudgment } from './llm/repair-verify'

export type DebugInput = Answer | 'undo' | 'quit'
export type DebugCommand = Extract<Command, { kind: 'debug' }>
/** 3: stopped at a question nobody could answer (--no-ask). */
export type DebugExitCode = ExitCode | 3

/** A model consulted after the oracle and before a person (`LlmOracle`). */
export interface DebugAdvisor {
  readonly model: string
  /** Whether it was already consulted about this call (or an identical one). */
  has(call: CallNode): boolean
  cached(call: CallNode): Consultation | null
  /** Its answer about this call, if it gave one. */
  answer(call: CallNode): AutoAnswer | null
  consult(call: CallNode): Promise<Consultation>
}

/** What a repair of the culprit produced: lines to print and the verified programs, in order. */
export interface RepairOffer {
  readonly lines: readonly string[]
  readonly verified: readonly string[]
}

/** Asks a model to repair function `protoId` so that the judged calls come out right. */
export type DebugRepairer = (
  protoId: number,
  judgments: readonly RepairJudgment[],
) => Promise<RepairOffer>

export interface DebugOptions {
  readonly strategy: Strategy
  /** Answers questions without a person (contracts and assertions); null: a person answers all. */
  readonly oracle: CallOracle | null
  /** Whether a person may be asked; false stops at the first open question (exit 3). */
  readonly ask: boolean
  /** A model asked before a person (`--llm`); null: none. */
  readonly advisor: DebugAdvisor | null
  /** Offered after a verdict (`--llm`, and only when a person may be asked); null: no offer. */
  readonly repairer: DebugRepairer | null
}

/** What happens after the verdict: nothing, or the steps of the repair offer. */
type FollowUp = 'none' | 'offer' | 'repairing' | 'choose'

const INPUTS: ReadonlyMap<string, DebugInput> = new Map([
  ['r', 'right'],
  ['right', 'right'],
  ['w', 'wrong'],
  ['wrong', 'wrong'],
  ['n', 'unsure'],
  ['?', 'unsure'],
  ['not sure', 'unsure'],
  ['unsure', 'unsure'],
  ['u', 'undo'],
  ['undo', 'undo'],
  ['q', 'quit'],
  ['quit', 'quit'],
])

const HELP = 'Please answer r (right), w (wrong), n or ? (not sure), u (undo) or q (quit).'
const PROMPT = 'Is that right? [r/w/n/u/q] '
const YES: ReadonlySet<string> = new Set(['y', 'yes'])
const NO: ReadonlySet<string> = new Set(['n', 'no', 'q', 'quit', ''])
/** Runtime errors that are a broken promise (assertion, precondition, postcondition). */
const CHECK_FAILURES: ReadonlySet<string> = new Set(['R018', 'R026', 'R027'])
/** The most lines of the buggy function the verdict shows. */
const CODE_FRAME_LINES = 14

/** The answer a line of input gives, or null when it is not one. */
export function parseAnswer(line: string): DebugInput | null {
  return INPUTS.get(line.trim().toLowerCase()) ?? null
}

/**
 * Loads and records the file, then prints the opening and the first question (or the verdict, when
 * there is nothing to ask). Returns an exit code instead when the file cannot be loaded.
 */
export function openDebugSession(
  io: CliIO,
  command: DebugCommand,
  assist: (tree: CallTree, loaded: Loaded) => Pick<DebugOptions, 'advisor' | 'repairer'> = () => ({
    advisor: null,
    repairer: null,
  }),
): DebugSession | ExitCode {
  const style = makeStyle(io.color)
  const loaded = load(io, style, command.file)
  if (!loaded) return 1
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const tree = callTree(recording)
  return new DebugSession(io, style, loaded, tree, {
    strategy: command.strategy,
    oracle: command.auto ? contractOracle(recording, tree) : null,
    ask: command.ask,
    ...assist(tree, loaded),
  })
}

export class DebugSession {
  private state: FinderState
  private outcome: 'open' | 'found' | 'quit' | 'unanswered' = 'open'
  private readonly options: DebugOptions
  /** The open question, while the advisor is to be asked about it first. */
  private pending: CallNode | null = null
  private followUp: FollowUp = 'none'
  private verified: readonly string[] = []

  constructor(
    private readonly io: CliIO,
    private readonly style: Style,
    private readonly loaded: Loaded,
    private readonly tree: CallTree,
    options: Partial<DebugOptions> = {},
  ) {
    this.options = {
      strategy: options.strategy ?? 'top-down',
      oracle: options.oracle ?? null,
      ask: options.ask ?? true,
      advisor: options.advisor ?? null,
      repairer: options.repairer ?? null,
    }
    this.state = startFinder(tree, tree.root, { justMyCode: true, strategy: this.options.strategy })
    this.introduce(tree.recording)
    this.next()
  }

  /** True once the interview and its follow-up are over. */
  get finished(): boolean {
    return this.outcome !== 'open' && this.followUp === 'none'
  }

  /**
   * Does the waiting the advisor needs: asks it about the open question (and the next ones, as
   * long as it is wanted), and runs an accepted repair. Resolves when a person has to type
   * something or the session is over. Never rejects: the advisor and the repairer never throw.
   */
  async settle(): Promise<void> {
    for (;;) {
      const call = this.pending
      if (call !== null) {
        this.pending = null
        await this.options.advisor?.consult(call)
        this.next()
      } else if (this.followUp === 'repairing') {
        await this.repairCulprit()
      } else {
        return
      }
    }
  }

  /**
   * 0 once a verdict was given, 3 when it stopped at a question nobody could answer (--no-ask),
   * 1 when the interview stopped without a verdict otherwise.
   */
  get exitCode(): DebugExitCode {
    if (this.outcome === 'found') return 0
    return this.outcome === 'unanswered' ? 3 : 1
  }

  /** Handles one line of input; returns false once the interview is over. */
  handle(line: string): boolean {
    if (this.followUp === 'offer') return this.answerOffer(line)
    if (this.followUp === 'choose') return this.chooseCandidate(line)
    if (this.outcome !== 'open') return false
    const input = parseAnswer(line)
    if (input === null) {
      if (line.trim() !== '') this.io.stdout(`${HELP}\n`)
      this.io.stdout(PROMPT)
      return true
    }
    if (input === 'quit') {
      this.outcome = 'quit'
      this.io.stdout('Stopped without a verdict.\n')
      return false
    }
    if (input === 'undo') this.takeBack()
    else this.state = answer(this.state, input)
    this.next()
    return !this.finished
  }

  /** The input ended: says so unless the interview was over. */
  end(): void {
    if (this.outcome !== 'open') return
    this.outcome = 'quit'
    this.io.stderr(`\n${this.style.error('stopped before a verdict')}: the input ended\n`)
  }

  private introduce(recording: Recording): void {
    const { io, style, loaded } = this
    const steps = recording.length.toLocaleString('en-US')
    io.stdout(`Recorded ${steps} steps of ${sanitize(loaded.file)}.\n`)
    const outcome = recording.outcome
    if (outcome.kind === 'error') {
      io.stderr(`${formatRuntimeError(loaded.file, loaded.source, outcome.error, style)}\n`)
      io.stdout(
        CHECK_FAILURES.has(outcome.error.code)
          ? 'The run failed a contract or an assertion (above); the questions below find the ' +
              'function to blame.\n'
          : 'The run ended with a runtime error (above). The bug finder is for wrong results, so ' +
              'the error is the place to start; the questions below can still lead to the code ' +
              'that produced a bad value.\n',
      )
    } else if (outcome.kind !== 'finished') {
      io.stdout(
        `The run stopped at the step limit (${steps} steps); calls still running then are marked unfinished.\n`,
      )
    }
    io.stdout(`${style.dim(`Answer each question with: ${HELP.slice('Please answer '.length)}`)}\n`)
  }

  private takeBack(): void {
    const taken = this.state.judgments[this.state.previous?.judgments.length ?? 0]
    const previous = undo(this.state)
    if (previous === this.state) {
      this.io.stdout('(nothing to take back)\n')
      return
    }
    const call = question(previous)
    const name = sanitize(call?.name ?? 'that call')
    this.io.stdout(
      taken?.auto === undefined
        ? `(took back the answer about ${name})\n`
        : `(took back the automatic answer about ${name}; it is yours to answer)\n`,
    )
    this.state = previous
  }

  /** The number the next question gets: every question so far, answered by anyone, counts. */
  private get questionNumber(): number {
    return this.state.asked + this.state.answeredAutomatically + 1
  }

  /**
   * Lets the oracle, then the advisor's answers so far, answer what they can, printing each
   * automatic answer with its evidence.
   */
  private answerAutomatically(): void {
    const { oracle, advisor } = this.options
    if (oracle === null && advisor === null) return
    const before = this.state
    const after = autoAnswer(before, (call) => oracle?.(call) ?? advisor?.answer(call) ?? null)
    let number = this.questionNumber
    for (const judgment of after.judgments.slice(before.judgments.length)) {
      if (judgment.auto === undefined) continue
      this.printAutomatic(number, judgment.call, judgment.auto)
      number += 1
    }
    this.state = after
  }

  private printAutomatic(number: number, call: CallNode, auto: AutoAnswer): void {
    const { io, style } = this
    const given = auto.answer === 'right' ? style.ok('right') : style.error('wrong')
    const text = sanitize(callText(this.tree.details(call)))
    const reason = style.dim(`(${sanitize(auto.reason)})`)
    io.stdout(`\n${style.bold(`Question ${number}:`)} ${text} — ${given} ${reason}\n`)
    const consulted = this.options.advisor?.cached(call)
    if (consulted?.kind === 'answer' && consulted.auto === auto && consulted.why !== '')
      io.stdout(`  ${style.dim(sanitize(consulted.why))}\n`)
  }

  /** True when the advisor should be asked about the open question before a person is. */
  private wantsAdvice(call: CallNode): boolean {
    const { advisor } = this.options
    return advisor !== null && !this.state.declined.has(call.id) && !advisor.has(call)
  }

  /** Prints the next question, or the verdict when the search is over. */
  private next(): void {
    this.answerAutomatically()
    const call = question(this.state)
    if (call === null) {
      this.printVerdict()
      return
    }
    if (this.wantsAdvice(call)) {
      this.pending = call
      return
    }
    const details = this.tree.details(call)
    const { io, style } = this
    const number = this.questionNumber
    io.stdout(`\n${style.bold(`Question ${number}:`)} ${sanitize(callText(details))}\n`)
    for (const change of changeTexts(details)) io.stdout(`  ${sanitize(change)}\n`)
    const consulted = this.options.advisor?.cached(call)
    if (consulted?.kind === 'abstain' && !this.state.declined.has(call.id))
      io.stdout(`  ${style.dim(`(left to you: ${sanitize(consulted.reason)})`)}\n`)
    if (details.lines)
      io.stdout(`  ${style.dim(`${sanitize(call.name)} · ${linesText(details.lines)}`)}\n`)
    if (this.state.strategy === 'divide') {
      const left = remaining(this.state)
      io.stdout(
        `  ${style.dim(`${left.toLocaleString('en-US')} ${left === 1 ? 'call' : 'calls'} still under suspicion`)}\n`,
      )
    }
    if (!this.options.ask) {
      this.outcome = 'unanswered'
      io.stdout(
        `${style.error('stopped')}: no contract or assertion answers this question, and --no-ask means nobody else is asked.\n`,
      )
      return
    }
    io.stdout(PROMPT)
  }

  private printVerdict(): void {
    const result = verdict(this.state)
    if (result.kind !== 'found') return
    this.outcome = 'found'
    const details = this.tree.details(result.call)
    const calls = this.tree.children(result.call, { justMyCode: this.state.justMyCode }).length
    const { io, style } = this
    const lead = result.certainty === 'certain' ? 'Found it' : 'Probably'
    io.stdout(
      `\n${style.ok(style.bold(`${lead}: the bug is in ${sanitize(culpritText(details))}.`))}\n`,
    )
    io.stdout(`${verdictReason(details, result.certainty, calls)}\n`)
    if (result.call.depth > 0) io.stdout(`${style.dim(sanitize(callText(details)))}\n`)
    if (details.lines)
      io.stdout(`\n${codeFrame(this.loaded.source, details.lines, style).join('\n')}\n`)
    this.printRepairs(result.call.protoId)
    this.printAssertions()
    this.offerRepair(result.call)
  }

  // --- the repair offer (--llm) -----------------------------------------------------------------

  private offerRepair(culprit: CallNode): void {
    const { repairer, advisor, ask } = this.options
    if (repairer === null || !ask || culprit.depth === 0) return
    const name = sanitize(culprit.name)
    const model = sanitize(advisor?.model ?? 'the model')
    this.io.stdout(
      `\nAsk ${model} to rewrite ${name}? Each candidate is checked by the VM against your answers. [y/n] `,
    )
    this.followUp = 'offer'
  }

  private answerOffer(line: string): boolean {
    const text = line.trim().toLowerCase()
    if (YES.has(text)) {
      this.followUp = 'repairing'
      return true
    }
    if (NO.has(text)) {
      this.followUp = 'none'
      return false
    }
    this.io.stdout('Please answer y or n. [y/n] ')
    return true
  }

  /** The judged calls, with what the advisor expected of the ones it judged wrong. */
  private judgments(): RepairJudgment[] {
    const judged: RepairJudgment[] = []
    for (const judgment of this.state.judgments) {
      if (judgment.remembered || judgment.answer === 'unsure') continue
      const consulted = this.options.advisor?.cached(judgment.call)
      const fromAdvisor =
        consulted?.kind === 'answer' && consulted.auto === judgment.auto ? consulted : null
      judged.push({
        call: judgment.call,
        answer: judgment.answer,
        expected: fromAdvisor?.auto.answer === 'wrong' ? fromAdvisor.expected : null,
        by: judgment.auto?.reason ?? 'you',
      })
    }
    return judged
  }

  private async repairCulprit(): Promise<void> {
    const result = verdict(this.state)
    const repairer = this.options.repairer
    this.followUp = 'none'
    if (result.kind !== 'found' || repairer === null) return
    const offer = await repairer(result.call.protoId, this.judgments())
    this.io.stdout(`${offer.lines.join('\n')}\n`)
    this.verified = offer.verified
    if (offer.verified.length === 0) return
    const range = offer.verified.length === 1 ? '1' : `1-${offer.verified.length}`
    this.io.stdout(`Write a candidate to ${sanitize(this.loaded.file)}? [${range}/n] `)
    this.followUp = 'choose'
  }

  private chooseCandidate(line: string): boolean {
    const text = line.trim().toLowerCase()
    if (NO.has(text)) {
      this.followUp = 'none'
      return false
    }
    const number = /^\d+$/.test(text) ? Number(text) : 0
    const source = this.verified[number - 1]
    if (source === undefined) {
      this.io.stdout('Please answer a candidate number or n. ')
      return true
    }
    this.followUp = 'none'
    writeProgram(this.io, this.style, this.loaded.file, source, `candidate ${number}`)
    return false
  }

  /** The calls the user judged right, as assertions the oracle will read next time. */
  private printAssertions(): void {
    const assertions = answerAssertions(this.tree, this.state)
    if (assertions.length === 0) return
    const { io, style } = this
    io.stdout(
      `\n${style.bold('Your answers as assertions')} (add them to the program and these questions answer themselves next time):\n`,
    )
    for (const assertion of assertions) io.stdout(`  ${sanitize(assertion.text)}\n`)
  }

  /** One-token repairs that agree with every answer given (ARCHITECTURE §7.12). */
  private printRepairs(protoId: number): void {
    const { io, style, tree } = this
    const examples = repairExamples(tree, this.state)
    const result = searchRepairs(tree.recording, { kind: 'examples', protoId, examples })
    if (result.problem !== null || result.repairs.length === 0) return
    io.stdout(
      `\n${style.bold('Repair previews')} (one-token changes that agree with your answers; check what the call returns):\n`,
    )
    io.stdout(`${repairLines(result, style).join('\n')}\n`)
  }
}

/** Writes a repaired program over `file`, reporting the outcome; false when it could not. */
export function writeProgram(
  io: CliIO,
  style: Style,
  file: string,
  source: string,
  what: string,
): boolean {
  if (io.writeBytes === undefined) {
    io.stderr(`${style.error('error')}: this host cannot write files\n`)
    return false
  }
  try {
    io.writeBytes(file, new TextEncoder().encode(source))
  } catch (error) {
    io.stderr(
      `${style.error('error')}: cannot write '${sanitize(file)}': ${sanitize((error as Error).message)}\n`,
    )
    return false
  }
  io.stdout(`Wrote ${what} to ${sanitize(file)}.\n`)
  return true
}

function callText(details: CallDetails): string {
  return `${callSignature(details)} ${outcomeText(details)}`
}

/** The function's lines with their numbers, cut after CODE_FRAME_LINES lines. */
function codeFrame(source: string, lines: LineSpan, style: Style): string[] {
  const index = new LineIndex(source)
  const last = Math.min(lines.end, lines.start + CODE_FRAME_LINES - 1)
  const width = Math.max(4, String(last).length)
  const frame: string[] = []
  for (let line = lines.start; line <= last; line++) {
    const text = sanitize(index.lineText(line).replace(/\t/g, ' '))
    frame.push(`${style.dim(String(line).padStart(width))} ${style.dim('|')} ${text}`)
  }
  const more = lines.end - last
  if (more > 0)
    frame.push(style.dim(`${' '.repeat(width)} … ${more} more ${more === 1 ? 'line' : 'lines'}`))
  return frame
}
