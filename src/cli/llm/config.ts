/**
 * Resolves `--llm` options and the environment into a provider configuration (ARCHITECTURE §9.2).
 * Nothing here talks to the network; a missing key or base URL is a clear error up front.
 */
import { DEFAULT_ANTHROPIC_MODEL } from './anthropic'
import type { LlmArgs, LlmConfig, ProviderName } from './types'

export const DEFAULT_MAX_CALLS = 40
export const DEFAULT_MIN_CONFIDENCE = 0.8
export const DEFAULT_TIMEOUT_MS = 300_000
const MIN_TIMEOUT_MS = 1_000
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

export type ConfigResult =
  { readonly ok: true; readonly config: LlmConfig } | { readonly ok: false; readonly error: string }

type Env = Readonly<Record<string, string | undefined>>

/** The trimmed value of an environment variable; null when unset or blank. */
function variable(env: Env, name: string): string | null {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? null : value
}

function providerOf(args: LlmArgs, env: Env): ProviderName | string {
  const given = args.provider ?? variable(env, 'HINDSIGHT_LLM_PROVIDER') ?? 'anthropic'
  if (given === 'anthropic' || given === 'openai') return given
  return `HINDSIGHT_LLM_PROVIDER must be anthropic or openai, got ${JSON.stringify(given)}`
}

/** An http(s) URL without a trailing slash, or null when `text` is not one. */
function baseUrl(text: string): string | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return text.replace(/\/+$/, '')
}

function timeoutOf(env: Env): number | string {
  const raw = variable(env, 'HINDSIGHT_LLM_TIMEOUT_MS')
  if (raw === null) return DEFAULT_TIMEOUT_MS
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS)
    return `HINDSIGHT_LLM_TIMEOUT_MS must be a whole number of milliseconds >= ${MIN_TIMEOUT_MS}`
  return value
}

export function resolveLlmConfig(args: LlmArgs, env: Env): ConfigResult {
  const provider = providerOf(args, env)
  if (provider !== 'anthropic' && provider !== 'openai') return { ok: false, error: provider }
  const timeoutMs = timeoutOf(env)
  if (typeof timeoutMs === 'string') return { ok: false, error: timeoutMs }
  const model = args.model ?? variable(env, 'HINDSIGHT_LLM_MODEL')
  if (provider === 'anthropic') {
    const apiKey = variable(env, 'ANTHROPIC_API_KEY')
    if (apiKey === null) {
      return {
        ok: false,
        error:
          '--llm=anthropic needs ANTHROPIC_API_KEY in the environment (for a local model use --llm=openai with HINDSIGHT_LLM_BASE_URL)',
      }
    }
    const url = baseUrl(variable(env, 'ANTHROPIC_BASE_URL') ?? ANTHROPIC_BASE_URL)
    if (url === null) return { ok: false, error: 'ANTHROPIC_BASE_URL must be an http(s) URL' }
    const config: LlmConfig = {
      provider,
      model: model ?? DEFAULT_ANTHROPIC_MODEL,
      baseUrl: url,
      apiKey,
      timeoutMs,
      maxCalls: args.maxCalls,
    }
    return { ok: true, config }
  }
  const given = variable(env, 'HINDSIGHT_LLM_BASE_URL')
  if (given === null) {
    return {
      ok: false,
      error:
        '--llm=openai needs HINDSIGHT_LLM_BASE_URL, an OpenAI-compatible endpoint such as http://localhost:11434/v1 (Ollama)',
    }
  }
  const url = baseUrl(given)
  if (url === null) return { ok: false, error: 'HINDSIGHT_LLM_BASE_URL must be an http(s) URL' }
  if (model === null) {
    return {
      ok: false,
      error: '--llm=openai needs a model: --llm-model NAME or HINDSIGHT_LLM_MODEL',
    }
  }
  const apiKey = variable(env, 'HINDSIGHT_LLM_API_KEY')
  return {
    ok: true,
    config: { provider, model, baseUrl: url, apiKey, timeoutMs, maxCalls: args.maxCalls },
  }
}
