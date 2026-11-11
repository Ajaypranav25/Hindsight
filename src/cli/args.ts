import { DEFAULT_MAX_STEPS, DEFAULT_SEED, type EditValue } from '../core/api-types'
import type { Strategy } from '../core/bug-finder'
import { parseSweepValues } from '../core/sweep'

export type Command =
  | {
      readonly kind: 'run'
      readonly file: string
      readonly maxSteps: number
      readonly seed: number
    }
  | { readonly kind: 'check'; readonly file: string }
  | { readonly kind: 'disasm'; readonly file: string }
  | {
      readonly kind: 'replay'
      readonly file: string
      readonly at: number
      readonly maxSteps: number
      readonly seed: number
    }
  | {
      readonly kind: 'why'
      readonly file: string
      readonly line: number
      readonly name: string
      readonly maxSteps: number
      readonly seed: number
    }
  | { readonly kind: 'test'; readonly dir: string }
  | { readonly kind: 'repl'; readonly seed: number }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | {
      readonly kind: 'whatif'
      readonly file: string
      readonly at: number
      readonly name: string
      /** The value to set; the first of `values` for a sweep. */
      readonly value: EditValue
      /** Every value of a sweep (`NAME=1..20`, `NAME=1, 5, 9`); one value otherwise. */
      readonly values: readonly EditValue[]
      readonly maxSteps: number
      readonly seed: number
    }
  | {
      readonly kind: 'debug'
      readonly file: string
      readonly strategy: Strategy
      readonly maxSteps: number
      readonly seed: number
    }
  | {
      readonly kind: 'solve'
      readonly file: string
      /** `output`: 1-based output line (null: the last line) that should read `text`. */
      readonly goal:
        | { readonly kind: 'output'; readonly line: number | null; readonly text: string }
        | { readonly kind: 'no-error' }
      readonly maxSteps: number
      readonly seed: number
    }
  | {
      readonly kind: 'query'
      readonly file: string
      readonly text: string
      readonly limit: number
      readonly maxSteps: number
      readonly seed: number
    }
  | {
      readonly kind: 'whynot'
      readonly file: string
      readonly line: number
      readonly maxSteps: number
      readonly seed: number
    }
  | {
      readonly kind: 'slice'
      readonly file: string
      /** The step to slice from; null: the crash, else the last output line. */
      readonly at: number | null
      readonly maxSteps: number
      readonly seed: number
    }
  | {
      readonly kind: 'repair'
      readonly file: string
      readonly maxSteps: number
      readonly seed: number
    }
  | { readonly kind: 'mcp' }

export type ParsedArgs =
  { readonly ok: true; readonly command: Command } | { readonly ok: false; readonly error: string }

export const USAGE = `hindsight: a tiny programming language with a time machine built in

Usage:
  hindsight run FILE [--max-steps N] [--seed S]     run a program
  hindsight check FILE                             report compile errors only
  hindsight disasm FILE                            show the bytecode
  hindsight replay FILE --at T [--max-steps N]     show the program state at step T
  hindsight why FILE --line L --name X             list every change to variable X declared on line L
  hindsight test [DIR]                             run annotated conformance files (default: tests/lang)
  hindsight repl [--seed S]                        interactive prompt
  hindsight whatif FILE --at T --set NAME=VALUE    replay from step T with NAME changed; diff the output
                                                   (NAME=1..20 or NAME=1,5,9 sweeps several values)
  hindsight debug FILE [--max-steps N] [--seed S]  find a bug by answering questions about calls
                 [--strategy divide|top-down]      (divide: halve the suspects with each answer)
  hindsight solve FILE --want TEXT [--output K]    find an earlier value that makes output line K
                                                   (default: the last) print TEXT
  hindsight solve FILE --no-crash                  find an earlier value that avoids the runtime error
  hindsight query FILE QUERY [--limit N]           jump by condition: 'when x > 3 and depth > 1',
                                                   'changed(order.paid)', 'calls(fib) where ret < 0'
  hindsight whynot FILE --line L                   explain why line L never ran
  hindsight slice FILE [--at T]                    mark the lines that led to step T (default: the
                                                   crash, else the last output line)
  hindsight repair FILE                            try one-token fixes for a crash
  hindsight mcp                                    serve the debugger to AI agents (MCP over stdio)
  hindsight --help | --version`

const VALUE_FLAGS = new Set([
  '--max-steps',
  '--seed',
  '--at',
  '--line',
  '--name',
  '--set',
  '--strategy',
  '--want',
  '--output',
  '--limit',
])
/** Options that take no value. */
const SWITCHES = new Set(['--no-crash'])

/** What each command accepts: its options, and how many arguments may follow its name. */
const COMMANDS: ReadonlyMap<string, { readonly flags: readonly string[]; readonly arity: number }> =
  new Map([
    ['run', { flags: ['--max-steps', '--seed'], arity: 1 }],
    ['check', { flags: [], arity: 1 }],
    ['disasm', { flags: [], arity: 1 }],
    ['replay', { flags: ['--at', '--max-steps', '--seed'], arity: 1 }],
    ['why', { flags: ['--line', '--name', '--max-steps', '--seed'], arity: 1 }],
    ['test', { flags: [], arity: 1 }],
    ['repl', { flags: ['--seed'], arity: 0 }],
    ['whatif', { flags: ['--at', '--set', '--max-steps', '--seed'], arity: 1 }],
    ['debug', { flags: ['--strategy', '--max-steps', '--seed'], arity: 1 }],
    ['solve', { flags: ['--want', '--output', '--no-crash', '--max-steps', '--seed'], arity: 1 }],
    ['query', { flags: ['--limit', '--max-steps', '--seed'], arity: 2 }],
    ['whynot', { flags: ['--line', '--max-steps', '--seed'], arity: 1 }],
    ['slice', { flags: ['--at', '--max-steps', '--seed'], arity: 1 }],
    ['repair', { flags: ['--max-steps', '--seed'], arity: 1 }],
    ['mcp', { flags: [], arity: 0 }],
  ])

/** Plain decimal integers only: no exponents, hex, signs other than '-', or spaces. */
const INTEGER_TEXT = /^-?\d+$/

interface Split {
  readonly positional: readonly string[]
  readonly flags: ReadonlyMap<string, string>
}

function split(argv: readonly string[]): Split | string {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [name, inline] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined]
    if (SWITCHES.has(name) && inline === undefined) {
      flags.set(name, '')
      continue
    }
    if (!VALUE_FLAGS.has(name)) return `unknown option '${name}'`
    const value = inline ?? argv[++i]
    if (value === undefined) return `option '${name}' needs a value`
    flags.set(name, value)
  }
  return { positional, flags }
}

function integerFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  min: number,
): number | string {
  const raw = flags.get(name)
  if (raw === undefined) return fallback
  const value = INTEGER_TEXT.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < min)
    return `option '${name}' must be an integer >= ${min}, got '${raw}'`
  return value
}

/** An error for options or arguments that `command` does not take, or null. */
function unexpected(command: string, parts: Split): string | null {
  const accepts = COMMANDS.get(command)
  if (accepts === undefined) return command ? `unknown command '${command}'` : 'missing command'
  for (const flag of parts.flags.keys()) {
    if (!accepts.flags.includes(flag)) return `option '${flag}' does not apply to '${command}'`
  }
  const extra = parts.positional[1 + accepts.arity]
  return extra === undefined ? null : `unexpected argument '${extra}'`
}

function needFile(positional: readonly string[], command: string): string | { error: string } {
  return positional[1] ?? { error: `'${command}' needs a FILE` }
}

/** Parses command-line arguments (without the node and script paths). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    return { ok: true, command: { kind: 'help' } }
  }
  if (argv[0] === '--version' || argv[0] === '-v') return { ok: true, command: { kind: 'version' } }
  const parts = split(argv)
  if (typeof parts === 'string') return { ok: false, error: parts }
  const { positional, flags } = parts
  const name = positional[0] ?? ''
  const problem = unexpected(name, parts)
  if (problem !== null) return { ok: false, error: problem }
  const maxSteps = integerFlag(flags, '--max-steps', DEFAULT_MAX_STEPS, 1)
  const seed = integerFlag(flags, '--seed', DEFAULT_SEED, Number.MIN_SAFE_INTEGER)
  if (typeof maxSteps === 'string') return { ok: false, error: maxSteps }
  if (typeof seed === 'string') return { ok: false, error: seed }

  switch (name) {
    case 'run':
    case 'check':
    case 'disasm': {
      const file = needFile(positional, name)
      if (typeof file !== 'string') return { ok: false, error: file.error }
      if (name === 'run') return { ok: true, command: { kind: 'run', file, maxSteps, seed } }
      return { ok: true, command: { kind: name, file } }
    }
    case 'replay': {
      const file = needFile(positional, name)
      if (typeof file !== 'string') return { ok: false, error: file.error }
      if (!flags.has('--at')) return { ok: false, error: "'replay' needs --at T" }
      const at = integerFlag(flags, '--at', 0, 0)
      if (typeof at === 'string') return { ok: false, error: at }
      return { ok: true, command: { kind: 'replay', file, at, maxSteps, seed } }
    }
    case 'why': {
      const file = needFile(positional, name)
      if (typeof file !== 'string') return { ok: false, error: file.error }
      const line = integerFlag(flags, '--line', 0, 1)
      const variable = flags.get('--name')
      if (!flags.has('--line') || typeof line === 'string')
        return { ok: false, error: "'why' needs --line L (a line number)" }
      if (!variable) return { ok: false, error: "'why' needs --name X" }
      return { ok: true, command: { kind: 'why', file, line, name: variable, maxSteps, seed } }
    }
    case 'test':
      return { ok: true, command: { kind: 'test', dir: positional[1] ?? 'tests/lang' } }
    case 'repl':
      return { ok: true, command: { kind: 'repl', seed } }
    case 'whatif':
      return whatIfCommand(positional, flags, maxSteps, seed)
    case 'debug': {
      const file = needFile(positional, name)
      if (typeof file !== 'string') return { ok: false, error: file.error }
      const strategy = flags.get('--strategy') ?? 'divide'
      if (strategy !== 'divide' && strategy !== 'top-down')
        return { ok: false, error: "--strategy must be 'divide' or 'top-down'" }
      return { ok: true, command: { kind: 'debug', file, strategy, maxSteps, seed } }
    }
    case 'solve':
      return solveCommand(positional, flags, maxSteps, seed)
    case 'query': {
      const file = needFile(positional, name)
      if (typeof file !== 'string') return { ok: false, error: file.error }
      const text = positional[2]
      if (text === undefined) return { ok: false, error: "'query' needs a QUERY after the file" }
      const limit = integerFlag(flags, '--limit', 50, 1)
      if (typeof limit === 'string') return { ok: false, error: limit }
      return { ok: true, command: { kind: 'query', file, text, limit, maxSteps, seed } }
    }
    case 'whynot': {
      const file = needFile(positional, name)
      if (typeof file !== 'string') return { ok: false, error: file.error }
      const line = integerFlag(flags, '--line', 0, 1)
      if (!flags.has('--line') || typeof line === 'string')
        return { ok: false, error: "'whynot' needs --line L (a line number)" }
      return { ok: true, command: { kind: 'whynot', file, line, maxSteps, seed } }
    }
    case 'slice': {
      const file = needFile(positional, name)
      if (typeof file !== 'string') return { ok: false, error: file.error }
      const at = integerFlag(flags, '--at', -1, 0)
      if (typeof at === 'string') return { ok: false, error: at }
      const step = flags.has('--at') ? at : null
      return { ok: true, command: { kind: 'slice', file, at: step, maxSteps, seed } }
    }
    case 'repair': {
      const file = needFile(positional, name)
      if (typeof file !== 'string') return { ok: false, error: file.error }
      return { ok: true, command: { kind: 'repair', file, maxSteps, seed } }
    }
    case 'mcp':
      return { ok: true, command: { kind: 'mcp' } }
    default:
      return { ok: false, error: `unknown command '${name}'` }
  }
}

const NAME_AND_VALUE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s

/** `whatif FILE --at T --set NAME=VALUE`: VALUE is a Hindsight literal. */
function whatIfCommand(
  positional: readonly string[],
  flags: ReadonlyMap<string, string>,
  maxSteps: number,
  seed: number,
): ParsedArgs {
  const file = needFile(positional, 'whatif')
  if (typeof file !== 'string') return { ok: false, error: file.error }
  if (!flags.has('--at')) return { ok: false, error: "'whatif' needs --at T" }
  const at = integerFlag(flags, '--at', 0, 0)
  if (typeof at === 'string') return { ok: false, error: at }
  const set = NAME_AND_VALUE.exec(flags.get('--set') ?? '')
  if (set === null) return { ok: false, error: "'whatif' needs --set NAME=VALUE" }
  const [, name = '', text = ''] = set
  const parsed = parseSweepValues(text)
  if (!parsed.ok) return { ok: false, error: `--set ${name}: ${parsed.error}` }
  const { values } = parsed
  return {
    ok: true,
    command: { kind: 'whatif', file, at, name, value: values[0] ?? null, values, maxSteps, seed },
  }
}

/** `solve FILE --want TEXT [--output K]` or `solve FILE --no-crash`. */
function solveCommand(
  positional: readonly string[],
  flags: ReadonlyMap<string, string>,
  maxSteps: number,
  seed: number,
): ParsedArgs {
  const file = needFile(positional, 'solve')
  if (typeof file !== 'string') return { ok: false, error: file.error }
  const want = flags.get('--want')
  if (flags.has('--no-crash')) {
    if (want !== undefined || flags.has('--output'))
      return { ok: false, error: "'solve' takes --want or --no-crash, not both" }
    return {
      ok: true,
      command: { kind: 'solve', file, goal: { kind: 'no-error' }, maxSteps, seed },
    }
  }
  if (want === undefined) return { ok: false, error: "'solve' needs --want TEXT (or --no-crash)" }
  const output = integerFlag(flags, '--output', 0, 1)
  if (typeof output === 'string') return { ok: false, error: output }
  const line = flags.has('--output') ? output : null
  return {
    ok: true,
    command: { kind: 'solve', file, goal: { kind: 'output', line, text: want }, maxSteps, seed },
  }
}
