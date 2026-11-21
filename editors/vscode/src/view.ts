/**
 * The editor-facing shape of an analysis, still free of `vscode`: command ids, the code lenses
 * (title, command, arguments), the inline why-not text, the step budget from the settings and the
 * lines of a compile-error report. `glue/` maps these one to one onto VS Code objects.
 */
import { DEFAULT_MAX_STEPS, functionLenses, neverRanLenses, type Problem } from './analysis'
import type { Recording } from '../../../src/core/index'

/** Every command the extension registers; package.json `contributes.commands` lists the same. */
export const COMMANDS = {
  runFile: 'hindsight.runFile',
  whyNot: 'hindsight.whyNot',
  crashSlice: 'hindsight.crashSlice',
  openInStudio: 'hindsight.openInStudio',
  clearHighlights: 'hindsight.clearHighlights',
} as const

/** The language id of `.sight` files. */
export const LANGUAGE_ID = 'sight'

/** Saves in a burst (save all, format on save) make one run after this pause. */
export const RUN_DELAY_MS = 300

/** The bounds of `hindsight.maxSteps`, as package.json declares them. */
export const MIN_STEPS = 1_000
export const MAX_STEPS = 10_000_000

/** A code lens: `command` null shows the title as plain text (nothing to click). */
export interface LensSpec {
  /** 1-based line the lens sits above. */
  readonly line: number
  readonly title: string
  readonly tooltip: string
  readonly command: string | null
}

/** The lenses of the last run: call counts above functions, "never ran" above unreached code. */
export function lensSpecs(recording: Recording): LensSpec[] {
  const calls: LensSpec[] = functionLenses(recording).map((lens) => ({
    line: lens.line,
    title: lens.title,
    tooltip: `How many times the last run called ${lens.name}`,
    command: null,
  }))
  const unreached: LensSpec[] = neverRanLenses(recording).map((lens) => ({
    line: lens.line,
    title: lens.title,
    tooltip: 'Explain why the last run never reached this code',
    command: COMMANDS.whyNot,
  }))
  return [...calls, ...unreached].sort((a, b) => a.line - b.line)
}

/** The longest inline explanation; the hover shows the whole sentence. */
export const INLINE_TEXT_LIMIT = 160

/** The why-not sentence as one line after the code, shortened at a word when it is long. */
export function inlineText(sentence: string, limit: number = INLINE_TEXT_LIMIT): string {
  const flat = sentence.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const cut = flat.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The step budget from the `hindsight.maxSteps` setting, which settings.json may set to anything. */
export function stepBudget(setting: unknown): number {
  if (typeof setting !== 'number' || !Number.isFinite(setting)) return DEFAULT_MAX_STEPS
  return Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.floor(setting)))
}

/** What "Run File" prints for a program that does not compile. */
export function problemReport(problems: readonly Problem[], fileName: string): string[] {
  const lines = problems.map(
    (p) => `[${fileName}:${p.start.line}:${p.start.column}] ${p.severity} ${p.code}: ${p.message}`,
  )
  return [...lines, `[${fileName}] did not compile; nothing ran`]
}

/** The 1-based line a command applies to: its argument when valid (a code lens), else the cursor. */
export function targetLine(argument: unknown, cursorLine: number, lineCount: number): number {
  const valid = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= lineCount
  return valid(argument) ? argument : Math.min(Math.max(1, cursorLine), Math.max(1, lineCount))
}
