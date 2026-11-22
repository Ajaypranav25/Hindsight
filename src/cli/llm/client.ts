/**
 * The model behind `--llm` (ARCHITECTURE §9.2): one provider, a hard cap on calls per command, and
 * a count of calls and tokens printed at the end. The client says once, before anything is sent,
 * which provider and model it uses and what leaves the machine.
 */
import { anthropicReply, anthropicRequest } from './anthropic'
import { postJson } from './http'
import { extractJson } from './json'
import { openAiReply, openAiRequest } from './openai'
import type { LlmConfig, LlmHost, LlmRequest, LlmResult } from './types'

export type JsonReply =
  | { readonly ok: true; readonly json: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string }

const count = (n: number) => n.toLocaleString('en-US')

export class LlmClient {
  private calls = 0
  private failures = 0
  private inputTokens = 0
  private outputTokens = 0

  constructor(
    readonly config: LlmConfig,
    private readonly host: LlmHost,
  ) {}

  get model(): string {
    return this.config.model
  }

  /** True once the cap on calls is reached. */
  get exhausted(): boolean {
    return this.calls >= this.config.maxCalls
  }

  /** The notice printed before the first request: who is asked and what is sent. */
  notice(): string {
    const { provider, model, baseUrl, maxCalls } = this.config
    return (
      `AI assistance: ${provider} model ${model} at ${baseUrl}. ` +
      `Function source and the values of calls are sent to it; at most ${count(maxCalls)} ${maxCalls === 1 ? 'request' : 'requests'}. ` +
      'The VM checks every answer it gives.'
    )
  }

  /** What was used, for the end of the command. */
  usage(): string {
    const failed = this.failures === 0 ? '' : ` (${count(this.failures)} failed)`
    return (
      `AI assistance used ${count(this.calls)} ${this.calls === 1 ? 'request' : 'requests'}${failed}, ` +
      `${count(this.inputTokens)} input and ${count(this.outputTokens)} output tokens (${this.config.model}).`
    )
  }

  /** Sends one request (never throws); refuses once the cap is reached. */
  async complete(request: LlmRequest): Promise<LlmResult> {
    if (this.exhausted) {
      return {
        ok: false,
        error: `the cap of ${count(this.config.maxCalls)} requests is reached (--llm-max-calls)`,
      }
    }
    this.calls += 1
    const { config } = this
    const http =
      config.provider === 'anthropic'
        ? anthropicRequest(config, request)
        : openAiRequest(config, request)
    const posted = await postJson(this.host, http, {
      timeoutMs: config.timeoutMs,
      secrets: config.apiKey === null ? [] : [config.apiKey],
    })
    const result: LlmResult = !posted.ok
      ? posted
      : config.provider === 'anthropic'
        ? anthropicReply(posted.json)
        : openAiReply(posted.json)
    if (result.ok) {
      this.inputTokens += result.usage.input
      this.outputTokens += result.usage.output
    } else {
      this.failures += 1
    }
    return result
  }

  /** Sends one request and reads the JSON object in the answer. */
  async completeJson(request: LlmRequest): Promise<JsonReply> {
    const result = await this.complete(request)
    if (!result.ok) return result
    const json = extractJson(result.text)
    if (json === null) return { ok: false, error: 'the answer was not a JSON object' }
    return { ok: true, json: json as Readonly<Record<string, unknown>> }
  }
}
