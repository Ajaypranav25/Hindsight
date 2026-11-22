/**
 * The `--llm` options of `debug` and `repair` (ARCHITECTURE §9.2). `--llm` alone or
 * `--llm=anthropic|openai` turns AI assistance on; the other options only refine it, so giving one
 * without `--llm` is a usage error rather than a silent no-op.
 */
import { DEFAULT_MAX_CALLS, DEFAULT_MIN_CONFIDENCE } from './config'
import type { LlmArgs } from './types'

/** Options of every command with AI assistance. */
export const LLM_FLAGS = ['--llm', '--llm-model', '--llm-max-calls'] as const
/** The oracle's extra option (`debug`). */
export const CONFIDENCE_FLAG = '--llm-min-confidence'
const REFINEMENTS = ['--llm-model', '--llm-max-calls', CONFIDENCE_FLAG]
const DECIMAL = /^(?:0|1)(?:\.\d+)?$|^\.\d+$/

/** The `--llm` options as given; null when `--llm` is absent; a message when they are wrong. */
export function llmArgs(flags: ReadonlyMap<string, string>): LlmArgs | null | string {
  const given = flags.get('--llm')
  if (given === undefined) {
    const stray = REFINEMENTS.find((flag) => flags.has(flag))
    return stray === undefined ? null : `option '${stray}' needs --llm`
  }
  if (given !== '' && given !== 'anthropic' && given !== 'openai')
    return `--llm takes no value or one of: anthropic, openai (got '${given}')`
  const model = flags.get('--llm-model')
  if (model !== undefined && model.trim() === '') return 'option --llm-model needs a model name'
  const calls = flags.get('--llm-max-calls')
  const maxCalls = calls === undefined ? DEFAULT_MAX_CALLS : Number(calls)
  if (
    calls !== undefined &&
    (!/^\d+$/.test(calls) || !Number.isSafeInteger(maxCalls) || maxCalls < 1)
  )
    return `option '--llm-max-calls' must be an integer >= 1, got '${calls}'`
  const confidence = flags.get(CONFIDENCE_FLAG)
  const minConfidence = confidence === undefined ? DEFAULT_MIN_CONFIDENCE : Number(confidence)
  if (confidence !== undefined && (!DECIMAL.test(confidence) || minConfidence > 1))
    return `option '${CONFIDENCE_FLAG}' must be a number from 0 to 1, got '${confidence}'`
  return {
    provider: given === '' ? null : given,
    model: model?.trim() ?? null,
    maxCalls,
    minConfidence,
  }
}
