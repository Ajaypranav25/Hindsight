/**
 * The OpenAI-compatible provider (ARCHITECTURE §9.2): `POST {base}/chat/completions`, which local
 * servers such as Ollama, llama.cpp, vLLM and LM Studio speak. The JSON shape is asked for in the
 * prompt rather than with `response_format`, which not every server accepts; the answer is parsed
 * leniently (`json.ts`). Sampling is pinned (temperature 0) so answers repeat where they can.
 */
import type { HttpRequest, LlmConfig, LlmRequest, LlmResult } from './types'

export function openAiRequest(config: LlmConfig, request: LlmRequest): HttpRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey !== null) headers.authorization = `Bearer ${config.apiKey}`
  const shape = `Answer with one JSON object and nothing else. Its JSON Schema: ${JSON.stringify(request.schema)}`
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers,
    body: {
      model: config.model,
      temperature: 0,
      max_tokens: request.maxTokens,
      messages: [
        { role: 'system', content: `${request.system}\n\n${shape}` },
        { role: 'user', content: request.prompt },
      ],
    },
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function openAiReply(json: unknown): LlmResult {
  if (json === null || typeof json !== 'object') return { ok: false, error: 'an empty reply' }
  const reply = json as { choices?: unknown; usage?: unknown }
  const usage = (reply.usage ?? {}) as Record<string, unknown>
  const tokens = { input: count(usage.prompt_tokens), output: count(usage.completion_tokens) }
  const choice = Array.isArray(reply.choices) ? (reply.choices[0] as unknown) : undefined
  if (choice === null || typeof choice !== 'object')
    return { ok: false, error: 'the reply has no choices' }
  const { message, finish_reason: finish } = choice as {
    message?: unknown
    finish_reason?: unknown
  }
  if (finish === 'length') return { ok: false, error: 'the answer was cut off at the token limit' }
  const content = (message as { content?: unknown } | null | undefined)?.content
  if (typeof content !== 'string' || content.trim() === '')
    return { ok: false, error: 'the reply has no text' }
  return { ok: true, text: content, usage: tokens }
}
