/**
 * The shapes the optional AI assistance shares (ARCHITECTURE §9.2): what a provider is asked, what
 * comes back, and the narrow view of the host (environment, network, timers) it runs on, so every
 * part can be tested with fakes and nothing touches the network unless `--llm` was given.
 */

/** The part of a fetch Response the providers read. */
export interface FetchResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
}

export interface FetchInit {
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal: AbortSignal
}

/** The global `fetch` of Node 22, narrowed to what the providers use. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>

/** What the AI assistance needs from the machine. */
export interface LlmHost {
  readonly env: Readonly<Record<string, string | undefined>>
  /** Absent when the runtime has no fetch: then `--llm` reports it instead of failing later. */
  readonly fetch: FetchLike | undefined
  /** Waits before the one retry; the real timer by default (tests pass an instant one). */
  readonly sleep?: (ms: number) => Promise<void>
}

export type ProviderName = 'anthropic' | 'openai'

/** The `--llm` options of a command, as parsed (ARCHITECTURE §9.2). */
export interface LlmArgs {
  /** `--llm=anthropic|openai`; null: HINDSIGHT_LLM_PROVIDER, else anthropic. */
  readonly provider: ProviderName | null
  /** `--llm-model`; null: HINDSIGHT_LLM_MODEL, else the provider's default. */
  readonly model: string | null
  /** `--llm-max-calls`: the hard cap on requests in one command. */
  readonly maxCalls: number
  /** `--llm-min-confidence`: below it the oracle leaves the question to a person. */
  readonly minConfidence: number
}

/** A provider, fully resolved from the options and the environment. */
export interface LlmConfig {
  readonly provider: ProviderName
  readonly model: string
  /** Without a trailing slash. */
  readonly baseUrl: string
  readonly apiKey: string | null
  readonly timeoutMs: number
  readonly maxCalls: number
}

export type Effort = 'low' | 'medium' | 'high'

/** One request: a system prompt, a user prompt and the JSON shape the answer must have. */
export interface LlmRequest {
  readonly system: string
  readonly prompt: string
  /** A JSON Schema (objects with `additionalProperties: false`), used where the model supports it. */
  readonly schema: Readonly<Record<string, unknown>>
  readonly effort: Effort
  readonly maxTokens: number
}

export interface TokenUsage {
  readonly input: number
  readonly output: number
}

/** A provider's answer: its text, or why there is none. Providers never throw. */
export type LlmResult =
  | { readonly ok: true; readonly text: string; readonly usage: TokenUsage }
  | { readonly ok: false; readonly error: string }

/** An HTTP request a provider wants sent. */
export interface HttpRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Readonly<Record<string, unknown>>
}
