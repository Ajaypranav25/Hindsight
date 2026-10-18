import { DEFAULT_MAX_STEPS, DEFAULT_SEED } from '../core/api-types'

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
  hindsight --help | --version`

const VALUE_FLAGS = new Set(['--max-steps', '--seed', '--at', '--line', '--name'])

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
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min)
    return `option '${name}' must be an integer >= ${min}, got '${raw}'`
  return value
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
  const maxSteps = integerFlag(flags, '--max-steps', DEFAULT_MAX_STEPS, 1)
  const seed = integerFlag(flags, '--seed', DEFAULT_SEED, -(2 ** 53))
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
    default:
      return { ok: false, error: name ? `unknown command '${name}'` : 'missing command' }
  }
}
