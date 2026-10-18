import { createInterface } from 'node:readline'
import { parseArgs, USAGE } from './args'
import { runCommand } from './commands'
import { nodeIO, type CliIO } from './io'
import { ReplSession } from './repl'

export const VERSION = '0.2.0'

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

/** Entry point; returns the process exit code (the REPL keeps the process alive instead). */
export function main(argv: readonly string[], io: CliIO = nodeIO): number | null {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    io.stderr(`error: ${parsed.error}\n\n${USAGE}\n`)
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
  return runCommand(command, io)
}

const invokedDirectly = /(?:main\.ts|hindsight\.mjs)$/.test(process.argv[1] ?? '')
if (invokedDirectly) {
  const code = main(process.argv.slice(2))
  if (code !== null) process.exitCode = code
}
