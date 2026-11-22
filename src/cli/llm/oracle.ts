/**
 * The LLM oracle for `hindsight debug --llm` (ARCHITECTURE §9.2): after contracts and assertions,
 * a model is asked what a call SHOULD return, without being shown what it did return (showing it
 * invites agreement). Its prediction is evaluated in the VM and compared with the recorded result
 * by language equality; only a confident, comparable prediction becomes an answer:
 *
 * - equal: right, unless the call changed something outside itself (the model judged the result
 *   only, so a person judges the effects);
 * - different: wrong (a wrong result is wrong whatever else the call did);
 * - anything else (low confidence, no prediction, not a value, not comparable, a call that did not
 *   return, a failed request, the cap reached): left to the person, with the reason.
 *
 * Answers are cached by the finder's memo key, so identical calls cost one request.
 */
import {
  type AutoAnswer,
  type CallNode,
  type CallTree,
  changeTexts,
  type Recording,
} from '../../core/index'
import { LANGUAGE_CHEAT_SHEET } from './cheatsheet'
import type { LlmClient } from './client'
import { callWithArguments, functionSource, helperSources } from './context'
import type { LlmRequest } from './types'
import { compareValues, evaluatePrediction } from './values'

/** What the model is asked to answer. */
export const PREDICTION_SCHEMA = {
  type: 'object',
  properties: {
    expected: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The value the call should return, as a Hindsight literal; null if unclear',
    },
    confidence: { type: 'number', description: 'From 0 (a guess) to 1 (certain)' },
    why: { type: 'string', description: 'One sentence' },
  },
  required: ['expected', 'confidence', 'why'],
  additionalProperties: false,
} as const

const SYSTEM = `You are a test oracle for programs written in Hindsight, a small dynamically typed language. You are shown a function and one call of it, and you say what the call SHOULD return if the function did what it is evidently meant to do: judge by its name, its parameters, its comments, its contracts and its helpers. The function may contain a bug, so do not trace its code to get the answer: work out the intended result from the arguments yourself.

Answer with JSON: {"expected": "<the value as Hindsight text>", "confidence": <0..1>, "why": "<one sentence>"}. Write the value as a literal: 91.66666666666667, "text", true, false, nil, [1, 2], {name: "Ada", age: 36}. Use full double precision for fractions. Give "expected": null when the intent is unclear or the result depends on something you cannot see. Confidence is the probability that your value is exactly what a correct implementation returns.

${LANGUAGE_CHEAT_SHEET}`

export type Consultation =
  | {
      readonly kind: 'answer'
      readonly auto: AutoAnswer
      /** The predicted value as `repr` shows it. */
      readonly expected: string
      readonly why: string
    }
  | {
      readonly kind: 'abstain'
      /** Why the question is left to the person, as a phrase. */
      readonly reason: string
      /** The predicted value, when there was one (shown, and used by repairs). */
      readonly expected: string | null
    }

interface RawPrediction {
  readonly expected: string | null
  readonly confidence: number
  readonly why: string
}

function readPrediction(json: Readonly<Record<string, unknown>>): RawPrediction | null {
  const { expected, confidence, why } = json
  if (expected !== null && typeof expected !== 'string') return null
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null
  return {
    expected,
    confidence: Math.min(1, Math.max(0, confidence)),
    why: typeof why === 'string' ? why.trim() : '',
  }
}

const percent = (confidence: number) => confidence.toFixed(2)

/** The prompt for one call: the function, its helpers and the call with its arguments. */
export function predictionRequest(tree: CallTree, call: CallNode): LlmRequest | null {
  const { recording } = tree
  const source = functionSource(recording, call.protoId)
  if (source === null) return null
  const helpers = helperSources(tree, call)
  const parts = [`The function:\n\`\`\`\n${source}\n\`\`\``]
  if (helpers.length > 0) {
    parts.push(`Functions it called during this call:\n\`\`\`\n${helpers.join('\n\n')}\n\`\`\``)
  }
  parts.push(
    `The call: ${callWithArguments(recording, tree.details(call))}\nWhat should this call return?`,
  )
  return {
    system: SYSTEM,
    prompt: parts.join('\n\n'),
    schema: PREDICTION_SCHEMA,
    effort: 'medium',
    maxTokens: 16_000,
  }
}

export class LlmOracle {
  private readonly cache = new Map<string, Consultation>()
  private readonly recording: Recording

  constructor(
    private readonly client: LlmClient,
    private readonly tree: CallTree,
    private readonly minConfidence: number,
  ) {
    this.recording = tree.recording
  }

  get model(): string {
    return this.client.model
  }

  private key(call: CallNode): string {
    return this.tree.keyOf(call) ?? `#${call.id}`
  }

  /** Whether the model was already consulted about this call (or an identical one). */
  has(call: CallNode): boolean {
    return this.cache.has(this.key(call))
  }

  /** The cached consultation about this call, if any. */
  cached(call: CallNode): Consultation | null {
    return this.cache.get(this.key(call)) ?? null
  }

  /** The cached answer, for the finder's automatic-answer path (null: none, or it abstained). */
  answer(call: CallNode): AutoAnswer | null {
    const known = this.cached(call)
    return known?.kind === 'answer' ? known.auto : null
  }

  /** Asks the model about a call once (cached by memo key); never throws. */
  async consult(call: CallNode): Promise<Consultation> {
    const known = this.cached(call)
    if (known !== null) return known
    const result = await this.ask(call)
    this.cache.set(this.key(call), result)
    return result
  }

  private abstain(reason: string, expected: string | null = null): Consultation {
    return { kind: 'abstain', reason, expected }
  }

  private async ask(call: CallNode): Promise<Consultation> {
    if (call.outcome !== 'returned') return this.abstain('the call did not return a value')
    const request = predictionRequest(this.tree, call)
    if (request === null) return this.abstain('its source is not part of the program')
    if (this.client.exhausted) {
      return this.abstain(`the cap of ${this.client.config.maxCalls} requests is reached`)
    }
    const reply = await this.client.completeJson(request)
    const model = this.client.model
    if (!reply.ok) return this.abstain(`${model} gave no usable answer: ${reply.error}`)
    const prediction = readPrediction(reply.json)
    if (prediction === null) return this.abstain(`${model}'s answer did not have the asked shape`)
    return this.judge(call, prediction)
  }

  private judge(call: CallNode, prediction: RawPrediction): Consultation {
    const model = this.client.model
    if (prediction.expected === null) return this.abstain(`${model} could not say`)
    const predicted = evaluatePrediction(prediction.expected)
    if (!predicted.ok) {
      return this.abstain(
        `${model}'s expected value ${JSON.stringify(prediction.expected)} is not a value: ${predicted.error}`,
      )
    }
    const shown = predicted.text
    if (prediction.confidence < this.minConfidence) {
      return this.abstain(
        `${model} expected ${shown} but is not sure (confidence ${percent(prediction.confidence)}, below ${percent(this.minConfidence)})`,
        shown,
      )
    }
    const details = this.tree.details(call)
    const comparison = compareValues(
      { recording: this.recording, time: call.exit + 1, value: details.result!.value },
      predicted.at,
    )
    if (comparison === 'unknown') {
      return this.abstain(`${model} expected ${shown}, which cannot be compared with the result`)
    }
    if (comparison === 'equal' && changeTexts(details).length > 0) {
      return this.abstain(
        `${model} expected ${shown}, as returned, but the call also changed things outside itself`,
        shown,
      )
    }
    const reason = `${model} expected ${shown}, confidence ${percent(prediction.confidence)}`
    return {
      kind: 'answer',
      auto: { answer: comparison === 'equal' ? 'right' : 'wrong', reason, line: null },
      expected: shown,
      why: prediction.why,
    }
  }
}
