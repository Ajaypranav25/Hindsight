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
})
