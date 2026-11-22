/**
 * The commands with AI assistance (ARCHITECTURE §9.2): `debug --llm` (the LLM oracle, then the
 * repair offer) and `repair --llm` (LLM rewrites of the crashed function). Nothing leaves the
 * machine unless --llm was given; then a notice says once, on stderr, which provider and model are
 * used and what is sent, and the calls and tokens used are printed at the end. The VM checks
 * everything the model says.
 */
import { record } from '../core/index'
import { load, type ExitCode } from './commands'
import { type DebugCommand, type DebugExitCode, openDebugSession, writeProgram } from './debug'
import type { Command } from './args'
import { makeStyle, sanitize, type Style } from './format'
import type { CliIO } from './io'
import { repairLines, searchRepairs } from './lab'
import { LlmClient } from './llm/client'
import { resolveLlmConfig } from './llm/config'
import { LlmOracle } from './llm/oracle'
import { aiRepair, repairReport, verifiedSources } from './llm/repair'
import type { FetchLike, LlmArgs, LlmHost } from './llm/types'

export type RepairCommand = Extract<Command, { kind: 'repair' }>

/** The real machine: the environment and Node's global fetch. */
export function nodeLlmHost(): LlmHost {
  const fetch =
    typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
  return { env: process.env, fetch: fetch as FetchLike | undefined }
}

/** The configured client, after the notice; null (with the reason on stderr) when misconfigured. */
export function openLlm(io: CliIO, style: Style, args: LlmArgs, host: LlmHost): LlmClient | null {
  const resolved = resolveLlmConfig(args, host.env)
  if (!resolved.ok) {
    io.stderr(`${style.error('error')}: ${sanitize(resolved.error)}\n`)
    return null
  }
  const client = new LlmClient(resolved.config, host)
  io.stderr(`${style.dim(sanitize(client.notice()))}\n`)
  return client
}

function printUsage(io: CliIO, style: Style, client: LlmClient): void {
  io.stderr(`${style.dim(sanitize(client.usage()))}\n`)
}

/**
 * `debug FILE --llm`: the interview with the model as the second oracle. Lines of input are read
 * one at a time and only while the session waits for a person, so piped answers stay in order.
 */
export async function runAiDebug(
  io: CliIO,
  command: DebugCommand,
  host: LlmHost,
  lines: AsyncIterable<string>,
): Promise<DebugExitCode> {
  const style = makeStyle(io.color)
  const llm = command.llm!
  const client = openLlm(io, style, llm, host)
  if (client === null) return 2
  const session = openDebugSession(io, command, (tree) => ({
    advisor: new LlmOracle(client, tree, llm.minConfidence),
    repairer: async (protoId, judgments) => {
      const goal = { kind: 'examples' as const, protoId, judgments }
      const result = await aiRepair(client, tree.recording, goal, { seed: command.seed })
      return { lines: repairReport(result, style, client.model), verified: verifiedSources(result) }
    },
  }))
  if (typeof session === 'number') {
    printUsage(io, style, client)
    return session
  }
  await session.settle()
  if (!session.finished) {
    for await (const line of lines) {
      session.handle(line)
      await session.settle()
      if (session.finished) break
    }
  }
  session.end()
  printUsage(io, style, client)
  return session.exitCode
}

/**
 * `repair FILE --llm [--apply N]`: the one-token previews first (no network), then the model's
 * rewrites of the function the run crashed in, each checked by the VM. `--apply N` writes the Nth
 * verified candidate of this run to FILE, after showing it.
 */
export async function runAiRepair(
  io: CliIO,
  command: RepairCommand,
  host: LlmHost,
): Promise<ExitCode> {
  const style = makeStyle(io.color)
  const loaded = load(io, style, command.file)
  if (!loaded) return 1
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  if (recording.outcome.kind !== 'error') {
    io.stderr(
      `${style.error('error')}: The run did not crash (for a wrong result, \`hindsight debug FILE --llm\` finds the function and offers an AI repair)\n`,
    )
    return 1
  }
  const client = openLlm(io, style, command.llm!, host)
  if (client === null) return 2
  const previews = searchRepairs(recording, { kind: 'crash' })
  if (previews.problem === null && previews.repairs.length > 0) {
    io.stdout(`${style.bold('Repair previews')} (one-token changes that make the run finish):\n`)
    io.stdout(`${repairLines(previews, style).join('\n')}\n`)
  }
  const result = await aiRepair(client, recording, { kind: 'crash' }, { seed: command.seed })
  io.stdout(`${repairReport(result, style, client.model).join('\n')}\n`)
  printUsage(io, style, client)
  const verified = verifiedSources(result)
  if (command.apply !== null) {
    const chosen = verified[command.apply - 1]
    if (chosen === undefined) {
      const have = verified.length === 0 ? 'none was verified' : `${verified.length} verified`
      io.stderr(
        `${style.error('error')}: there is no verified candidate ${command.apply} (${have}); nothing was written\n`,
      )
      return 1
    }
    return writeProgram(io, style, loaded.file, chosen, `candidate ${command.apply}`) ? 0 : 1
  }
  if (verified.length > 0) {
    io.stdout(
      `${style.dim('Nothing was written. --apply N writes the Nth verified candidate of a run (candidates can differ between runs).')}
`,
    )
  }
  return verified.length > 0 || previews.repairs.length > 0 ? 0 : 1
}
