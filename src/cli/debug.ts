/**
 * `hindsight debug FILE` (ARCHITECTURE §7.6, §9): the bug finder as an interview on stdin and
 * stdout. Each question shows a recorded call and what it returned; answers arrive one per line
 * (r, w, n or ?, u, q), from a terminal or from a pipe, so an interview can be scripted. It ends
 * with the verdict and the buggy function's code.
 */
import {
  answer,
  type Answer,
  callSignature,
  type CallDetails,
  type CallTree,
  callTree,
  changeTexts,
  culpritText,
  type FinderState,
  LineIndex,
  type LineSpan,
  linesText,
  outcomeText,
  question,
  record,
  type Recording,
  startFinder,
  undo,
  verdict,
  verdictReason,
} from '../core/index'
import type { Command } from './args'
import { type ExitCode, load, type Loaded } from './commands'
import { formatRuntimeError, makeStyle, sanitize, type Style } from './format'
import type { CliIO } from './io'

export type DebugInput = Answer | 'undo' | 'quit'
export type DebugCommand = Extract<Command, { kind: 'debug' }>

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
export function openDebugSession(io: CliIO, command: DebugCommand): DebugSession | ExitCode {
  const style = makeStyle(io.color)
  const loaded = load(io, style, command.file)
  if (!loaded) return 1
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  return new DebugSession(io, style, loaded, callTree(recording))
}

export class DebugSession {
  private state: FinderState
  private outcome: 'open' | 'found' | 'quit' = 'open'

  constructor(
    private readonly io: CliIO,
    private readonly style: Style,
    private readonly loaded: Loaded,
    private readonly tree: CallTree,
  ) {
    this.state = startFinder(tree, tree.root, { justMyCode: true })
    this.introduce(tree.recording)
    this.next()
  }

  get finished(): boolean {
    return this.outcome !== 'open'
  }

  /** 0 once a verdict was given, 1 when the interview stopped without one. */
  get exitCode(): ExitCode {
    return this.outcome === 'found' ? 0 : 1
  }

  /** Handles one line of input; returns false once the interview is over. */
  handle(line: string): boolean {
    if (this.finished) return false
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
        'The run ended with a runtime error (above). The bug finder is for wrong results, so the ' +
          'error is the place to start; the questions below can still lead to the code that ' +
          'produced a bad value.\n',
      )
    } else if (outcome.kind !== 'finished') {
      io.stdout(
        `The run stopped at the step limit (${steps} steps); calls still running then are marked unfinished.\n`,
      )
    }
    io.stdout(`${style.dim(`Answer each question with: ${HELP.slice('Please answer '.length)}`)}\n`)
  }

  private takeBack(): void {
    const previous = undo(this.state)
    if (previous === this.state) {
      this.io.stdout('(nothing to take back)\n')
      return
    }
    const call = question(previous)
    this.io.stdout(`(took back the answer about ${sanitize(call?.name ?? 'that call')})\n`)
    this.state = previous
  }

  /** Prints the next question, or the verdict when the search is over. */
  private next(): void {
    const call = question(this.state)
    if (call === null) {
      this.printVerdict()
      return
    }
    const details = this.tree.details(call)
    const { io, style } = this
    const number = this.state.asked + 1
    io.stdout(`\n${style.bold(`Question ${number}:`)} ${sanitize(callText(details))}\n`)
    for (const change of changeTexts(details)) io.stdout(`  ${sanitize(change)}\n`)
    if (details.lines)
      io.stdout(`  ${style.dim(`${sanitize(call.name)} · ${linesText(details.lines)}`)}\n`)
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
  }
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
