import { describe, expect, test } from 'vitest'
import { DEFAULT_MAX_STEPS, DEFAULT_SEED } from '../core/api-types'
import { parseArgs } from './args'

describe('parseArgs', () => {
  test('defaults to help', () => {
    expect(parseArgs([])).toEqual({ ok: true, command: { kind: 'help' } })
    expect(parseArgs(['--help'])).toEqual({ ok: true, command: { kind: 'help' } })
    expect(parseArgs(['--version'])).toEqual({ ok: true, command: { kind: 'version' } })
  })

  test('parses run with defaults and options in both spellings', () => {
    expect(parseArgs(['run', 'a.sight'])).toEqual({
      ok: true,
      command: { kind: 'run', file: 'a.sight', maxSteps: DEFAULT_MAX_STEPS, seed: DEFAULT_SEED },
    })
    expect(parseArgs(['run', 'a.sight', '--max-steps', '10', '--seed=7'])).toEqual({
      ok: true,
      command: { kind: 'run', file: 'a.sight', maxSteps: 10, seed: 7 },
    })
  })

  test('parses the file commands', () => {
    expect(parseArgs(['check', 'x.sight'])).toEqual({
      ok: true,
      command: { kind: 'check', file: 'x.sight' },
    })
    expect(parseArgs(['disasm', 'x.sight'])).toEqual({
      ok: true,
      command: { kind: 'disasm', file: 'x.sight' },
    })
  })

  test('parses replay and why', () => {
    expect(parseArgs(['replay', 'x.sight', '--at', '12'])).toMatchObject({
      ok: true,
      command: { kind: 'replay', file: 'x.sight', at: 12 },
    })
    expect(parseArgs(['why', 'x.sight', '--line', '3', '--name', 'total'])).toMatchObject({
      ok: true,
      command: { kind: 'why', file: 'x.sight', line: 3, name: 'total' },
    })
  })

  test('parses test and repl', () => {
    expect(parseArgs(['test'])).toEqual({ ok: true, command: { kind: 'test', dir: 'tests/lang' } })
    expect(parseArgs(['test', 'mine'])).toEqual({
      ok: true,
      command: { kind: 'test', dir: 'mine' },
    })
    expect(parseArgs(['repl', '--seed', '3'])).toEqual({
      ok: true,
      command: { kind: 'repl', seed: 3 },
    })
  })

  test('reports helpful errors', () => {
    expect(parseArgs(['run'])).toEqual({ ok: false, error: "'run' needs a FILE" })
    expect(parseArgs(['launch'])).toEqual({ ok: false, error: "unknown command 'launch'" })
    expect(parseArgs(['run', 'a', '--fast'])).toEqual({
      ok: false,
      error: "unknown option '--fast'",
    })
    expect(parseArgs(['run', 'a', '--seed'])).toEqual({
      ok: false,
      error: "option '--seed' needs a value",
    })
    expect(parseArgs(['run', 'a', '--max-steps', '0'])).toMatchObject({ ok: false })
    expect(parseArgs(['replay', 'a'])).toEqual({ ok: false, error: "'replay' needs --at T" })
    expect(parseArgs(['why', 'a', '--name', 'x'])).toMatchObject({ ok: false })
    expect(parseArgs(['why', 'a', '--line', '2'])).toEqual({
      ok: false,
      error: "'why' needs --name X",
    })
    expect(parseArgs(['--seed', '1'])).toEqual({ ok: false, error: 'missing command' })
  })

  test('rejects arguments a command does not take instead of ignoring them', () => {
    expect(parseArgs(['check', 'a.sight', 'b.sight'])).toEqual({
      ok: false,
      error: "unexpected argument 'b.sight'",
    })
    expect(parseArgs(['run', 'a.sight', 'b.sight'])).toEqual({
      ok: false,
      error: "unexpected argument 'b.sight'",
    })
    expect(parseArgs(['test', 'a', 'b'])).toEqual({ ok: false, error: "unexpected argument 'b'" })
    expect(parseArgs(['repl', 'x'])).toEqual({ ok: false, error: "unexpected argument 'x'" })
  })

  test('rejects options that do not apply to the command', () => {
    expect(parseArgs(['run', 'a.sight', '--at', '5'])).toEqual({
      ok: false,
      error: "option '--at' does not apply to 'run'",
    })
    expect(parseArgs(['check', 'a.sight', '--seed', '1'])).toEqual({
      ok: false,
      error: "option '--seed' does not apply to 'check'",
    })
    expect(parseArgs(['replay', 'a.sight', '--at', '3', '--name', 'x'])).toEqual({
      ok: false,
      error: "option '--name' does not apply to 'replay'",
    })
    expect(parseArgs(['repl', '--max-steps', '5'])).toEqual({
      ok: false,
      error: "option '--max-steps' does not apply to 'repl'",
    })
  })

  test('integer options must be plain decimal integers', () => {
    for (const raw of ['', '1e3', '0x10', ' 5', '5 ', '1.0', '+5', '99999999999999999999']) {
      expect(parseArgs(['run', 'a.sight', `--seed=${raw}`])).toMatchObject({ ok: false })
    }
    expect(parseArgs(['run', 'a.sight', '--seed=-7'])).toMatchObject({
      ok: true,
      command: { seed: -7 },
    })
    expect(parseArgs(['replay', 'a.sight', '--at', '1e3'])).toEqual({
      ok: false,
      error: "option '--at' must be an integer >= 0, got '1e3'",
    })
  })

  test('the smallest seed the message promises is accepted', () => {
    const smallest = String(Number.MIN_SAFE_INTEGER)
    expect(parseArgs(['run', 'a.sight', '--seed', smallest])).toMatchObject({
      ok: true,
      command: { seed: Number.MIN_SAFE_INTEGER },
    })
    expect(parseArgs(['run', 'a.sight', '--seed', '-9007199254740992'])).toEqual({
      ok: false,
      error: `option '--seed' must be an integer >= ${smallest}, got '-9007199254740992'`,
    })
  })
})
