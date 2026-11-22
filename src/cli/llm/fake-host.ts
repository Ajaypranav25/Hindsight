/**
 * A scripted stand-in for the network, for tests: each request gets the next canned reply, and
 * every request is kept so tests can check what would have been sent. No test touches the network.
 */
import type { FetchInit, FetchResponse, LlmHost } from './types'

export interface CannedReply {
  readonly status?: number
  /** A JSON value (sent as JSON) or raw text. */
  readonly body: unknown
  readonly headers?: Readonly<Record<string, string>>
  /** Throw this instead of answering (a network failure). */
  readonly fail?: Error
  /** Never answer; reject when the request is aborted (a timeout). */
  readonly hang?: boolean
}

export interface SentRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown>
}

export interface FakeHost extends LlmHost {
  readonly sent: SentRequest[]
  readonly waits: number[]
}

function response(reply: CannedReply): FetchResponse {
  const status = reply.status ?? 200
  const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(text),
  }
}

/** A host whose fetch answers with `replies` in order (the last one repeats). */
export function fakeHost(
  replies: readonly CannedReply[],
  env: Readonly<Record<string, string | undefined>> = {},
): FakeHost {
  const sent: SentRequest[] = []
  const waits: number[] = []
  let next = 0
  return {
    env,
    sent,
    waits,
    sleep: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    },
    fetch: (url: string, init: FetchInit) => {
      sent.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body) as Record<string, unknown>,
      })
      const reply = replies[Math.min(next, replies.length - 1)]!
      next += 1
      if (reply.fail !== undefined) return Promise.reject(reply.fail)
      if (reply.hang === true) {
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      return Promise.resolve(response(reply))
    },
  }
}

/** A Messages API reply whose text is `text` (JSON values are written as JSON). */
export function anthropicText(text: unknown, usage = { input_tokens: 100, output_tokens: 20 }) {
  return {
    body: {
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [
        { type: 'thinking', thinking: '', signature: 'x' },
        { type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) },
      ],
      stop_reason: 'end_turn',
      usage,
    },
  } satisfies CannedReply
}
