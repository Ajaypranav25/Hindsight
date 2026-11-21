/**
 * `hindsight infer` (ARCHITECTURE §7.16, §9): likely `requires`/`ensures` clauses for the functions
 * of a run, each held in every recorded call and checked by recording the program again with the
 * clauses written in. `--write` adds them to the function headers in the file (only then is the
 * file changed). The workflow: infer on a version you trust, add the clauses, and on a later,
 * broken version `hindsight debug` answers its own questions from them.
 */
import {
  callTree,
  type FunctionContracts,
  inferContracts,
  type InferResult,
  record,
  withContracts,
} from '../core/index'
import type { Command } from './args'
import type { ExitCode, Loaded } from './commands'
import { sanitize, type Style } from './format'
import type { CliIO } from './io'
import { outcomeNote } from './profile'

type InferCommand = Extract<Command, { kind: 'infer' }>

export function inferCommand(
  io: CliIO,
  style: Style,
  loaded: Loaded,
  command: InferCommand,
): ExitCode {
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const result = inferContracts(recording, callTree(recording), {
    fn: command.fn ?? undefined,
    seed: command.seed,
  })
  if (command.fn !== null && result.functions.length === 0) {
    io.stderr(
      `${style.error('error')}: no function '${sanitize(command.fn)}' declared with fn in ${sanitize(loaded.file)}\n`,
    )
    return 1
  }
  const out = report(result, style)
  const note = outcomeNote(recording.outcome)
  if (note !== null) out.unshift(style.dim(note.replace('the profile covers', 'inferred from')), '')
  io.stdout(`${out.join('\n')}\n`)
  return command.write ? writeClauses(io, style, loaded, result) : 0
}

function report(result: InferResult, style: Style): string[] {
  const out: string[] = []
  if (result.functions.length === 0) out.push('no functions declared with fn')
  for (const fn of result.functions) out.push(...functionLines(fn, style), '')
  const total = result.functions.reduce((sum, fn) => sum + fn.suggestions.length, 0)
  if (result.problem !== null) out.push(style.error(`not checked: ${result.problem}`))
  else if (total > 0 && result.verified) {
    const withdrawn =
      result.withdrawn > 0
        ? `; ${result.withdrawn} more ${result.withdrawn === 1 ? 'was' : 'were'} withdrawn`
        : ''
    out.push(
      style.ok('checked') +
        `: the program runs the same with ${total === 1 ? 'this clause' : `these ${total} clauses`} written in${withdrawn}`,
    )
  }
  if (total > 0) {
    out.push(
      style.dim(
        'They describe what the program did, not what it should do: keep the ones you agree with ' +
          '(--write adds them all; --fn NAME picks one function). Added to a version you trust, ' +
          'they let `hindsight debug` answer its own questions on a later, broken one.',
      ),
    )
  }
  return out
}

function functionLines(fn: FunctionContracts, style: Style): string[] {
  const inputs = `${fn.inputs} different ${fn.inputs === 1 ? 'input' : 'inputs'}`
  const calls = `${fn.calls} ${fn.calls === 1 ? 'call' : 'calls'}`
  const sampled = fn.sampled < fn.calls ? ` (${fn.sampled} read)` : ''
  const head =
    style.bold(sanitize(fn.name)) + style.dim(` (line ${fn.line}) · ${calls}${sampled}, ${inputs}`)
  if (fn.suggestions.length === 0) return [head, style.dim(`  ${fn.note ?? 'nothing to suggest'}`)]
  const width = Math.max(...fn.suggestions.map((s) => s.kind.length + 1 + s.clause.length))
  return [
    head,
    ...fn.suggestions.map((s) => {
      const text = `${s.kind.padEnd(8)} ${s.clause}`
      const support = `${s.support.inputs} ${s.support.inputs === 1 ? 'input' : 'inputs'}`
      return `  ${sanitize(text.padEnd(width + 1))}  ${style.dim(`${support} · e.g. ${sanitize(s.example.text)}`)}`
    }),
  ]
}

function writeClauses(io: CliIO, style: Style, loaded: Loaded, result: InferResult): ExitCode {
  const picks = result.functions.filter((fn) => fn.suggestions.length > 0)
  if (picks.length === 0) {
    io.stdout(`${style.dim('nothing to write')}\n`)
    return 0
  }
  if (io.writeFile === undefined) {
    io.stderr(`${style.error('error')}: this host cannot write files\n`)
    return 1
  }
  const source = withContracts(loaded.source, picks)
  try {
    io.writeFile(loaded.file, source)
  } catch (error) {
    io.stderr(
      `${style.error('error')}: cannot write '${sanitize(loaded.file)}': ${sanitize((error as Error).message)}\n`,
    )
    return 1
  }
  const clauses = picks.reduce((sum, fn) => sum + fn.suggestions.length, 0)
  io.stdout(
    `${style.ok('wrote')} ${clauses} ${clauses === 1 ? 'clause' : 'clauses'} into ${picks.length} ${picks.length === 1 ? 'function' : 'functions'} of ${sanitize(loaded.file)}\n`,
  )
  return 0
}
