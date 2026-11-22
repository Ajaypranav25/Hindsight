/**
 * One JSON POST with a timeout and one retry on 429 and 5xx (ARCHITECTURE §9.2). Failures come back
 * as messages, never as exceptions, and never contain the secrets passed in (API keys are masked
 * wherever they might appear).
 */
import type { FetchResponse, HttpRequest, LlmHost } from './types'

/** The wait before the retry when the server does not say (`retry-after`). */
export const RETRY_DELAY_MS = 2_000
/** The longest `retry-after` honored; a longer wait is not worth holding a command for. */
export const MAX_RETRY_DELAY_MS = 20_000
const MAX_MESSAGE = 300

export type HttpResult =
  { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly error: string }

export interface PostOptions {
  readonly timeoutMs: number
  /** Texts masked out of every message (the API key). */
  readonly secrets: readonly string[]
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** `text` with every secret replaced by `***`, cut to a readable length. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join('***')
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}…` : out
}

/** The error type and message of an API error body (Anthropic and OpenAI shapes), if any. */
function apiError(body: string): { readonly type: string | null; readonly message: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { type: null, message: body.trim() }
  }
  const error = (parsed as { error?: unknown } | null)?.error
  if (typeof error === 'string') return { type: null, message: error }
  if (error !== null && typeof error === 'object') {
    const { type, message } = error as { type?: unknown; message?: unknown }
    return {
      type: typeof type === 'string' ? type : null,
      message: typeof message === 'string' ? message : '',
    }
  }
  return { type: null, message: body.trim() }
}

const HINTS: ReadonlyMap<number, string> = new Map([
  [401, ' (check the API key)'],
  [403, ' (the key may not have access to this model)'],
  [404, ' (check the model name, --llm-model, and the base URL)'],
])

function statusMessage(status: number, body: string): string {
  const { type, message } = apiError(body)
  const kind = type === null ? '' : ` ${type}`
  const text = message === '' ? '' : `: ${message}`
  return `HTTP ${status}${kind}${text}${HINTS.get(status) ?? ''}`
}

/** A 429 that waiting cannot fix (the monthly spend cap). */
function isSpendCap(body: string): boolean {
  return body.includes('enforced_spend_limit_reached')
}

function retryDelay(response: FetchResponse): number {
  const header = response.headers.get('retry-after')
  const seconds = header === null ? Number.NaN : Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return RETRY_DELAY_MS
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1000))
}

type Attempt =
  | { readonly kind: 'done'; readonly result: HttpResult }
  | { readonly kind: 'retry'; readonly delay: number; readonly error: string }

async function attempt(
  host: LlmHost,
  request: HttpRequest,
  options: PostOptions,
): Promise<Attempt> {
  const fetch = host.fetch
  if (fetch === undefined) {
    return {
      kind: 'done',
      result: { ok: false, error: 'this Node has no fetch (Node 22+ needed)' },
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    })
    const body = await response.text()
    if (response.ok) {
      try {
        return { kind: 'done', result: { ok: true, json: JSON.parse(body) } }
      } catch {
        return { kind: 'done', result: { ok: false, error: 'the reply was not JSON' } }
      }
    }
    const error = statusMessage(response.status, body)
    const retryable = response.status >= 500 || (response.status === 429 && !isSpendCap(body))
    if (retryable) return { kind: 'retry', delay: retryDelay(response), error }
    return { kind: 'done', result: { ok: false, error } }
  } catch (caught) {
    const error = controller.signal.aborted
      ? `no answer within ${Math.round(options.timeoutMs / 1000)} s (HINDSIGHT_LLM_TIMEOUT_MS)`
      : `could not reach ${new URL(request.url).host}: ${describe(caught)}`
    return { kind: 'done', result: { ok: false, error } }
  } finally {
    clearTimeout(timer)
  }
}

function describe(caught: unknown): string {
  if (!(caught instanceof Error)) return String(caught)
  const cause = (caught as { cause?: unknown }).cause
  return cause instanceof Error ? `${caught.message} (${cause.message})` : caught.message
}

/** POSTs `request` as JSON and parses the reply; one retry after a 429 or 5xx. */
export async function postJson(
  host: LlmHost,
  request: HttpRequest,
  options: PostOptions,
): Promise<HttpResult> {
  const first = await attempt(host, request, options)
  let result: HttpResult
  if (first.kind === 'done') {
    result = first.result
  } else {
    await (host.sleep ?? defaultSleep)(first.delay)
    const second = await attempt(host, request, options)
    result =
      second.kind === 'done'
        ? second.result
        : { ok: false, error: `${second.error} (also on the retry)` }
  }
  return result.ok ? result : { ok: false, error: redact(result.error, options.secrets) }
}
