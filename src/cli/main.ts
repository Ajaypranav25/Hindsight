import { createInterface } from 'node:readline'
import { parseArgs, USAGE } from './args'
import { runCommand } from './commands'
import { type DebugCommand, openDebugSession } from './debug'
import { isEntryPoint } from './entry'
import { sanitize } from './format'
import { exitQuietlyOnClosedPipe, nodeIO, type CliIO } from './io'
import { ReplSession } from './repl'

/** Kept equal to package.json's version (a test checks). */
export const VERSION = '0.1.0'

function startRepl(io: CliIO, seed: number): void {
  const session = new ReplSession(io, seed)
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'sight> ',
  })
  io.stdout(`Hindsight ${VERSION} REPL. Type :help for help, :quit to leave.\n`)
  prompt.prompt()
  prompt.on('line', (line) => {
    if (!session.handle(line)) prompt.close()
    else prompt.prompt()
  })
}

/**
 * The bug finder's interview: answers are read line by line from stdin, whether it is a terminal
 * or a pipe. The exit code is set when the input ends or the interview does.
 */
function startDebug(io: CliIO, command: DebugCommand): number | null {
  const session = openDebugSession(io, command)
  if (typeof session === 'number') return session
  if (session.finished) return session.exitCode
  const input = createInterface({ input: process.stdin, terminal: false })
  input.on('line', (line) => {
    if (!session.handle(line)) input.close()
  })
  input.on('close', () => {
    session.end()
    process.exitCode = session.exitCode
  })
  return null
}

/** Entry point; returns the process exit code (the REPL keeps the process alive instead). */
export function main(argv: readonly string[], io: CliIO = nodeIO): number | null {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    // The message can quote arguments, which may hold terminal control sequences.
    io.stderr(`error: ${sanitize(parsed.error)}\n\n${USAGE}\n`)
    return 2
  }
  const { command } = parsed
  if (command.kind === 'help') {
    io.stdout(`${USAGE}\n`)
    return 0
  }
  if (command.kind === 'version') {
    io.stdout(`hindsight ${VERSION}\n`)
    return 0
  }
  if (command.kind === 'repl') {
    startRepl(io, command.seed)
    return null
  }
  if (command.kind === 'debug') return startDebug(io, command)
  return runCommand(command, io)
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  // A closed pipe ends the process, but with the outcome the command already decided.
  const exit = (code: number) =>
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : code)
  exitQuietlyOnClosedPipe(process.stdout, exit)
  exitQuietlyOnClosedPipe(process.stderr, exit)
  const code = main(process.argv.slice(2))
  if (code !== null) process.exitCode = code
}
