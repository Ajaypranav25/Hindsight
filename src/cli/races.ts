/**
 * `hindsight races FILE` (ARCHITECTURE §7.16, §9): records a program with tasks under many random
 * schedules and reports the different results, where the first two diverge and the shared places
 * more than one task wrote before they did. Exit codes follow diff(1): 0 when every schedule did
 * the same, 1 when results differ, 2 for usage or compile trouble.
 */
import {
  exploreSchedules,
  type RaceCandidate,
  type ScheduleExploration,
  type ScheduleGroup,
} from '../core/index'
import type { Command } from './args'
import { type ExitCode, load } from './commands'
import { originLines } from './diff'
import { makeStyle, sanitize, type Style } from './format'
import type { CliIO } from './io'
import { outcomeText } from './whatif'

export type RacesCommand = Extract<Command, { kind: 'races' }>

const count = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`
/** Seeds listed per group before "…". */
const SEEDS_SHOWN = 6
/** Output characters shown per group. */
const OUTPUT_SHOWN = 60

export function racesCommand(io: CliIO, command: RacesCommand): ExitCode {
  const style = makeStyle(io.color)
  const loaded = load(io, style, command.file)
  if (loaded === null) return 2
  const found = exploreSchedules(loaded.program, {
    runs: command.runs,
    seed: command.seed,
    quantum: command.quantum,
    maxSteps: command.maxSteps,
  })
  const lines = [style.bold(headline(found)), ...groupLines(found, style)]
  if (!found.usesTasks) {
    lines.push(
      style.dim('the program never started a task, so every schedule runs it the same way'),
    )
  } else if (found.divergence === null) {
    lines.push(style.ok('every schedule gave the same result'))
  } else {
    lines.push(...divergenceLines(found, command, style))
  }
  io.stdout(`${lines.join('\n')}\n`)
  return found.groups.length > 1 ? 1 : 0
}

function headline(found: ScheduleExploration): string {
  const results = plural(found.groups.length, 'different result')
  return `${plural(found.runs, 'schedule')} (random, quantum ${count(found.quantum)}): ${results}`
}

function groupLines(found: ScheduleExploration, style: Style): string[] {
  const width = String(found.runs).length
  return found.groups.map((group) => {
    const runs = `${String(group.seeds.length).padStart(width)} ${group.seeds.length === 1 ? 'run ' : 'runs'}`
    return `  ${runs}  ${groupText(group)}  ${style.dim(seedsText(group.seeds))}`
  })
}

function groupText(group: ScheduleGroup): string {
  const output = group.outputs.join(' / ')
  const shown = output.length > OUTPUT_SHOWN ? `${output.slice(0, OUTPUT_SHOWN - 1)}…` : output
  const printed =
    group.outputs.length === 0 ? 'printed nothing' : `printed ${JSON.stringify(shown)}`
  const ending = group.outcome.kind === 'finished' ? '' : `, ${outcomeText(group.recording)}`
  return sanitize(`${printed}${ending}`)
}

function seedsText(seeds: readonly number[]): string {
  const shown = seeds.slice(0, SEEDS_SHOWN).join(', ')
  return `seed${seeds.length === 1 ? '' : 's'} ${shown}${seeds.length > SEEDS_SHOWN ? ', …' : ''}`
}

function divergenceLines(
  found: ScheduleExploration,
  command: RacesCommand,
  style: Style,
): string[] {
  const divergence = found.divergence!
  const { seedA, seedB, step, outputIndex } = divergence
  const what =
    outputIndex === null ? 'their outcomes differ' : `output line ${count(outputIndex + 1)} differs`
  const lines = [
    '',
    `seeds ${seedA} and ${seedB} run the same until step ${count(step)}, then interleave differently; ${what}`,
    ...candidateLines(divergence.candidates, style),
    ...originLines(divergence.diff, null, style),
    '',
    style.dim(
      `replay: hindsight replay ${sanitize(command.file)} --schedule random --schedule-seed ${seedB} --quantum ${found.quantum} --at ${step}`,
    ),
  ]
  return lines
}

function candidateLines(candidates: readonly RaceCandidate[], style: Style): string[] {
  if (candidates.length === 0) {
    return [style.dim('no shared place was written by more than one task before that')]
  }
  const head = style.bold('race candidates (written by more than one task before that):')
  return [
    head,
    ...candidates.map((candidate) => {
      const writers = candidate.writers
        .map((writer) => `task ${writer.task} (${writer.name}) ${count(writer.writes)}×`)
        .join(', ')
      const lines =
        candidate.lines.length === 0
          ? ''
          : ` · line${candidate.lines.length === 1 ? '' : 's'} ${candidate.lines.join(', ')}`
      return `  ${style.bold(sanitize(candidate.name))}  ${sanitize(writers)}${style.dim(lines)}`
    }),
  ]
}
