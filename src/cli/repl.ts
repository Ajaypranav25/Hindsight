import { compile, run } from '../core/index'
import { formatDiagnostic, formatRuntimeError, makeStyle, sanitize } from './format'
import type { CliIO } from './io'

export const REPL_HELP = `Type Hindsight statements. Each entry is added to the program, which is re-run
from the start with the same seed; only new output is printed. Entries that fail are discarded.
Commands: :help, :source (show the program so far), :reset (start over), :quit`

/**
 * A REPL session (ARCHITECTURE §9): accepted entries accumulate into one program that is re-run
 * from scratch on every entry, so the whole session stays deterministic and replayable.
 */
export class ReplSession {
  private accepted = ''
  private printed = 0
  private readonly style

  constructor(
    private readonly io: CliIO,
    private readonly seed: number,
  ) {
    this.style = makeStyle(io.color)
  }

  get source(): string {
    return this.accepted
  }

  /** Handles one input line; returns false when the session should end. */
  handle(line: string): boolean {
    const entry = line.trim()
    if (entry === '') return true
    if (entry === ':quit' || entry === ':q') return false
    if (entry === ':help') this.io.stdout(`${REPL_HELP}\n`)
    else if (entry === ':source') this.io.stdout(sanitize(this.accepted) || '(empty)\n')
    else if (entry === ':reset') this.reset()
    else this.evaluate(line)
    return true
  }

  private reset(): void {
    this.accepted = ''
    this.printed = 0
    this.io.stdout('program cleared\n')
  }

  private evaluate(line: string): void {
    const candidate = `${this.accepted}${line}\n`
    const compiled = compile(candidate)
    if (!compiled.ok) {
      for (const diagnostic of compiled.diagnostics) {
        this.io.stderr(`${formatDiagnostic('<repl>', candidate, diagnostic, this.style)}\n`)
      }
      return
    }
    const result = run(compiled.program, { seed: this.seed })
    const fresh = result.outputs.slice(this.printed)
    // Program output is the program's own and is passed through raw, as `run` does.
    for (const event of fresh) this.io.stdout(`${event.text}\n`)
    if (result.outcome.kind === 'error') {
      this.io.stderr(
        `${formatRuntimeError('<repl>', candidate, result.outcome.error, this.style)}\n`,
      )
      this.io.stderr(this.style.dim('(entry discarded)\n'))
      return
    }
    if (result.outcome.kind !== 'finished') {
      this.io.stderr(
        this.style.dim('(entry discarded: the program did not finish within the step limit)\n'),
      )
      return
    }
    this.accepted = candidate
    this.printed = result.outputs.length
  }
}
