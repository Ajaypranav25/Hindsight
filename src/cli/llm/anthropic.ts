/**
 * The Anthropic provider (ARCHITECTURE §9.2): the Messages API over plain `fetch` (the CLI is one
 * bundle with no runtime dependencies). Current models think adaptively by default, so no
 * `thinking` field is sent; depth is set with `output_config.effort`, the answer's shape with
 * `output_config.format` (structured outputs), and declined requests fall back server-side to
 * the model Anthropic recommends (`fallbacks: "default"`) where the model supports it.
 */
import type { HttpRequest, LlmConfig, LlmRequest, LlmResult } from './types'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'
export const ANTHROPIC_VERSION = '2026-10-21'
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** Models that take `output_config.effort`. */
const EFFORT_MODELS = /^claude-(opus-(4-[5-9]|5)|fable-|mythos-|sonnet-(5|4-6)|haiku-5)/
/** Models that take `output_config.format` (structured outputs). */
const FORMAT_MODELS = /^claude-(opus-(5|4-8|4-5|4-1)|fable-|mythos-|sonnet-5|haiku-(5|4-5))/
/** Models with server-side refusal fallbacks in the `"default"` form. */
const FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
])

export function anthropicRequest(config: LlmConfig, request: LlmRequest): HttpRequest {
  const { model } = config
  const fallback = FALLBACK_MODELS.has(model)
  const outputConfig: Record<string, unknown> = {}
  if (EFFORT_MODELS.test(model)) outputConfig.effort = request.effort
  if (FORMAT_MODELS.test(model))
    outputConfig.format = { type: 'json_schema', schema: request.schema }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': config.apiKey ?? '',
    'anthropic-version': ANTHROPIC_VERSION,
  }
  if (fallback) headers['anthropic-beta'] = FALLBACK_BETA
  return {
    url: `${config.baseUrl}/v1/messages`,
    headers,
    body: {
      model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      ...(fallback ? { fallbacks: 'default' } : {}),
    },
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The text of a Messages API response, or why there is none (refusal, cut off, odd shape). */
export function anthropicReply(json: unknown): LlmResult {
  if (json === null || typeof json !== 'object') return { ok: false, error: 'an empty reply' }
  const reply = json as { content?: unknown; stop_reason?: unknown; usage?: unknown }
  const usage = (reply.usage ?? {}) as Record<string, unknown>
  const tokens = {
    input:
      count(usage.input_tokens) +
      count(usage.cache_creation_input_tokens) +
      count(usage.cache_read_input_tokens),
    output: count(usage.output_tokens),
  }
  if (reply.stop_reason === 'refusal') {
    return { ok: false, error: 'the model declined to answer (stop reason: refusal)' }
  }
  if (reply.stop_reason === 'max_tokens') {
    return { ok: false, error: 'the answer was cut off at the token limit' }
  }
  if (!Array.isArray(reply.content)) return { ok: false, error: 'the reply has no content' }
  const text = reply.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('')
  if (text.trim() === '') return { ok: false, error: 'the reply has no text' }
  return { ok: true, text, usage: tokens }
}
