import { describe, expect, test } from 'vitest'
import { DEFAULT_MAX_STEPS } from '../core/api-types'
import { type RepairCommand, runAiDebug, runAiRepair } from './ai'
import type { DebugCommand } from './debug'
import type { CliIO } from './io'
import { DEFAULT_ANTHROPIC_MODEL } from './llm/anthropic'
import { anthropicText, type CannedReply, fakeHost } from './llm/fake-host'
import type { LlmArgs } from './llm/types'

interface FakeIO extends CliIO {
  readonly out: string[]
  readonly err: string[]
  readonly written: Map<string, string>
}

function fakeIO(files: Record<string, string>, canWrite = true): FakeIO {
  const out: string[] = []
  const err: string[] = []
  const written = new Map<string, string>()
  return {
    out,
    err,
    written,
    color: false,
    readFile(path) {
      const content = files[path]
      if (content === undefined) throw new Error('no such file')
      return content
    },
    ...(canWrite
      ? {
          writeBytes: (path: string, bytes: Uint8Array) =>
            void written.set(path, new TextDecoder().decode(bytes)),
        }
      : {}),
    listFiles: () => [],
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }
}

const ENV = { ANTHROPIC_API_KEY: 'sk-ant-secret-key' }
const LLM: LlmArgs = { provider: null, model: null, maxCalls: 40, minConfidence: 0.8 }
const MODEL = DEFAULT_ANTHROPIC_MODEL

const AVERAGE = `fn total(xs) {
  var sum = 0
  for x in xs {
    sum += x
  }
  sum
}
fn average(xs) {
  total(xs) / (len(xs) - 1)
}
print(average([88, 83, 79]))
`
const AVERAGE_FIX = 'fn average(xs) {\n  total(xs) / len(xs)\n}'
const CRASH = 'fn last(xs) {\n  xs[len(xs) - 0]\n}\nlet items = [4, 5]\nprint(last(items))\n'
const CRASH_FIX = 'fn last(xs) {\n  xs[len(xs) - 1]\n}'

const predict = (expected: string | null, confidence = 0.95, why = 'The mean of the numbers.') =>
  anthropicText({ expected, confidence, why })
const rewrite = (fn: string, explanation = 'Divide by the count.') =>
  anthropicText({ candidates: [{ function: fn, explanation }] })

async function* linesOf(lines: readonly string[]): AsyncGenerator<string> {
  for (const line of lines) yield line
}

function debugCommand(overrides: Partial<DebugCommand> = {}): DebugCommand {
  return {
    kind: 'debug',
    file: 'avg.sight',
    strategy: 'top-down',
    auto: true,
    ask: true,
    llm: LLM,
    maxSteps: DEFAULT_MAX_STEPS,
    seed: 1,
    ...overrides,
  }
}

async function debug(
  replies: readonly CannedReply[],
  lines: readonly string[],
  overrides: Partial<DebugCommand> = {},
  env: Record<string, string> = ENV,
) {
  const io = fakeIO({ 'avg.sight': AVERAGE })
  const host = fakeHost(replies, env)
  const code = await runAiDebug(io, debugCommand(overrides), host, linesOf(lines))
  return { io, host, code, out: io.out.join(''), err: io.err.join('') }
}

describe('debug --llm', () => {
  test('the model answers the questions it is sure of, then offers a repair the VM checks', async () => {
    // Arrange
    const replies = [predict('83.33333333333333'), predict('250'), rewrite(AVERAGE_FIX)]

    // Act
    const { io, host, code, out, err } = await debug(replies, ['y', '1'])

    // Assert
    expect(code).toBe(0)
    expect(err).toContain(`AI assistance: anthropic model ${MODEL} at https://api.anthropic.com.`)
    expect(err).toContain('Function source and the values of calls are sent to it')
    expect(out).toContain(
      `Question 1: average(xs = [88, 83, 79]) returned 125 — wrong (${MODEL} expected 83.33333333333333, confidence 0.95)`,
    )
    expect(out).toContain('  The mean of the numbers.')
    expect(out).toContain(
      `Question 2: total(xs = [88, 83, 79]) returned 250 — right (${MODEL} expected 250, confidence 0.95)`,
    )
    expect(out).toContain('Found it: the bug is in average')
    expect(out).toContain(
      `Ask ${MODEL} to rewrite average? Each candidate is checked by the VM against your answers. [y/n] `,
    )
    expect(out).toContain('✓ Candidate 1: Divide by the count.')
    expect(out).toContain('average(xs = [88, 83, 79]) now returns 83.33333333333333, as expected')
    expect(out).toContain('Write a candidate to avg.sight? [1/n] ')
    expect(out).toContain('Wrote candidate 1 to avg.sight.')
    expect(io.written.get('avg.sight')).toBe(AVERAGE.replace('(len(xs) - 1)', 'len(xs)'))
    expect(err).toMatch(/AI assistance used 3 requests, [\d,]+ input and [\d,]+ output tokens/)
    expect(host.sent).toHaveLength(3)
    expect(JSON.stringify(host.sent[0]!.body)).not.toContain('125')
    expect(err).not.toContain('sk-ant-secret-key')
  })

  test('an unsure model leaves the question to you; undo takes back its answer without asking it again', async () => {
    // Arrange
    const replies = [predict('83.33333333333333'), predict('250', 0.5)]

    // Act
    const { code, host, out } = await debug(replies, ['u', 'w', 'r', 'n'])

    // Assert
    expect(code).toBe(0)
    expect(out).toContain(
      `(left to you: ${MODEL} expected 250 but is not sure (confidence 0.50, below 0.80))`,
    )
    expect(out).toContain('(took back the automatic answer about average; it is yours to answer)')
    expect(out).toMatch(/Question 1: average\(xs = \[88, 83, 79\]\) returned 125\n {2}average · lines/)
    expect(out).toContain('Found it: the bug is in average')
    expect(host.sent).toHaveLength(2)
  })

  test('with --no-ask it stops where the model abstains, and makes no repair offer', async () => {
    // Arrange
    const replies = [predict(null)]

    // Act
    const { code, out } = await debug(replies, [], { ask: false })

    // Assert
    expect(code).toBe(3)
    expect(out).toContain(`(left to you: ${MODEL} could not say)`)
    expect(out).toContain('--no-ask means nobody else is asked')
    expect(out).not.toContain('to rewrite')
  })

  test('declining the offer, or a repair that verifies nothing, writes nothing', async () => {
    // Arrange
    const sure = [predict('83.33333333333333'), predict('250')]

    // Act
    const declined = await debug(sure, ['n'])
    const rejected = await debug(
      [...sure, rewrite('fn average(xs) {\n  total(xs) / (len(xs) - 1)\n}')],
      ['yes'],
    )

    // Assert
    expect(declined.code).toBe(0)
    expect(declined.host.sent).toHaveLength(2)
    expect(declined.io.written.size).toBe(0)
    expect(rejected.out).toContain('✗ rejected: Divide by the count.')
    expect(rejected.out).toContain('0 of 2 candidates verified in 2 rounds')
    expect(rejected.out).not.toContain('Write a candidate')
    expect(rejected.io.written.size).toBe(0)
  })

  test('asks again on an unclear answer to the offer or the choice, and reports a host that cannot write', async () => {
    // Arrange
    const io = fakeIO({ 'avg.sight': AVERAGE }, false)
    const host = fakeHost([predict('83.33333333333333'), predict('250'), rewrite(AVERAGE_FIX)], ENV)

    // Act
    const code = await runAiDebug(io, debugCommand(), host, linesOf(['maybe', 'y', '7', '1']))

    // Assert
    expect(code).toBe(0)
    expect(io.out.join('')).toContain('Please answer y or n. [y/n] ')
    expect(io.out.join('')).toContain('Please answer a candidate number or n. ')
    expect(io.err.join('')).toContain('error: this host cannot write files')
  })

  test('a missing key is reported before anything is sent; a file that does not compile still counts usage', async () => {
    // Arrange, Act
    const noKey = await debug([predict('1')], [], {}, {})
    const io = fakeIO({ 'avg.sight': 'let = 1\n' })
    const host = fakeHost([predict('1')], ENV)
    const bad = await runAiDebug(io, debugCommand(), host, linesOf([]))

    // Assert
    expect(noKey.code).toBe(2)
    expect(noKey.err).toContain('error: --llm=anthropic needs ANTHROPIC_API_KEY')
    expect(noKey.host.sent).toHaveLength(0)
    expect(bad).toBe(1)
    expect(io.err.join('')).toContain('AI assistance used 0 requests')
    expect(host.sent).toHaveLength(0)
  })
})

function repairCommand(apply: number | null, file = 'crash.sight'): RepairCommand {
  return { kind: 'repair', file, llm: LLM, apply, maxSteps: DEFAULT_MAX_STEPS, seed: 1 }
}

async function repair(replies: readonly CannedReply[], apply: number | null, source = CRASH) {
  const io = fakeIO({ 'crash.sight': source })
  const host = fakeHost(replies, ENV)
  const code = await runAiRepair(io, repairCommand(apply), host)
  return { io, host, code, out: io.out.join(''), err: io.err.join('') }
}

describe('repair --llm', () => {
  test('prints the one-token previews, then the verified rewrites; --apply 1 writes the first', async () => {
    // Arrange
    const replies = [rewrite(CRASH_FIX, 'The last index is len - 1.')]

    // Act
    const { io, code, out, err } = await repair(replies, 1)

    // Assert
    expect(code).toBe(0)
    expect(out).toContain('Repair previews (one-token changes that make the run finish):')
    expect(out).toContain(
      `AI repair of last (lines 1–3) by ${MODEL}, each candidate checked by the VM:`,
    )
    expect(out).toContain('✓ Candidate 1: The last index is len - 1.')
    expect(out).toContain('Wrote candidate 1 to crash.sight.')
    expect(io.written.get('crash.sight')).toBe(CRASH.replace('- 0', '- 1'))
    expect(err).toMatch(/AI assistance used 1 request,/)
  })

  test('without --apply nothing is written; --apply past the verified ones writes nothing and fails', async () => {
    // Arrange
    const replies = [rewrite(CRASH_FIX)]

    // Act
    const shown = await repair(replies, null)
    const missing = await repair(replies, 2)

    // Assert
    expect(shown.code).toBe(0)
    expect(shown.out).toContain('Nothing was written. --apply N writes the Nth verified candidate')
    expect(shown.io.written.size).toBe(0)
    expect(missing.code).toBe(1)
    expect(missing.err).toContain(
      'there is no verified candidate 2 (1 verified); nothing was written',
    )
    expect(missing.io.written.size).toBe(0)
  })

  test('a run that did not crash, or a bad configuration, sends nothing', async () => {
    // Arrange
    const io = fakeIO({ 'crash.sight': CRASH })
    const host = fakeHost([rewrite(CRASH_FIX)], {})

    // Act
    const fine = await repair([rewrite(CRASH_FIX)], null, 'print(1)\n')
    const noKey = await runAiRepair(io, repairCommand(null), host)
    const missing = await runAiRepair(fakeIO({}), repairCommand(null, 'nope.sight'), host)

    // Assert
    expect(fine.code).toBe(1)
    expect(fine.err).toContain('The run did not crash')
    expect(fine.host.sent).toHaveLength(0)
    expect(noKey).toBe(2)
    expect(missing).toBe(1)
    expect(host.sent).toHaveLength(0)
  })

  test('when no candidate verifies, the exit code is 1 unless a one-token preview worked', async () => {
    // Arrange
    const noPreview = 'fn last(xs) {\n  xs["end"]\n}\nprint(last([4, 5]))\n'
    const wrong = rewrite('fn last(xs) {\n  xs[9]\n}')

    // Act
    const withPreview = await repair([wrong], null)
    const without = await repair([wrong], null, noPreview)

    // Assert
    expect(withPreview.code).toBe(0)
    expect(withPreview.out).toContain('0 of 2 candidates verified in 2 rounds')
    expect(without.code).toBe(1)
  })
})
