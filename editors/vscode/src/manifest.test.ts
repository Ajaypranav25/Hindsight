/**
 * The extension's declarative files (package.json, the grammar, the language configuration) kept in
 * step with the code and with the language: command ids, setting bounds, keywords and builtins.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { BUILTIN_NAMES } from '../../../src/core/builtin-names'
import { KEYWORDS } from '../../../src/core/tokens'
import { DEFAULT_MAX_STEPS } from './analysis'
import { DEFAULT_STUDIO_URL } from './studio-link'
import { COMMANDS, LANGUAGE_ID, MAX_STEPS, MIN_STEPS } from './view'

type Json = Record<string, unknown>

function readJson(relative: string): Json {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as Json
}

const manifest = readJson('../package.json')
const grammar = readJson('../syntaxes/sight.tmLanguage.json')
const languageConfiguration = readJson('../language-configuration.json')
const contributes = manifest.contributes as Json

/** Every object in a JSON tree, without recursion. */
function objects(root: unknown): Json[] {
  const found: Json[] = []
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    if (Array.isArray(value)) stack.push(...value)
    else if (value !== null && typeof value === 'object') {
      found.push(value as Json)
      stack.push(...Object.values(value))
    }
  }
  return found
}

/** The alternatives of a `\b(?:a|b|c)\b` word pattern. */
function words(pattern: string): string[] {
  const body = /\(\?:([^)]*)\)/.exec(pattern)?.[1]
  if (body === undefined) throw new Error(`not a word list: ${pattern}`)
  return body.split('|')
}

function repositoryRule(name: string): Json {
  return (grammar.repository as Record<string, Json>)[name]!
}

function patternsNamed(rule: Json, name: string): string[] {
  return objects(rule)
    .filter((o) => o.name === name && typeof o.match === 'string')
    .map((o) => o.match as string)
}

describe('package.json', () => {
  test('declares exactly the commands the extension registers', () => {
    const declared = (contributes.commands as Json[]).map((c) => c.command)

    expect([...declared].sort()).toEqual(Object.values(COMMANDS).sort())
    for (const command of contributes.commands as Json[]) expect(command.category).toBe('Hindsight')
  })

  test('menus refer only to declared commands', () => {
    const declared = new Set(Object.values(COMMANDS) as string[])
    const menus = Object.values(contributes.menus as Record<string, Json[]>).flat()

    for (const item of menus) expect(declared.has(item.command as string)).toBe(true)
  })

  test('activates on the sight language and contributes it for .sight files', () => {
    const [language] = contributes.languages as Json[]

    expect(manifest.activationEvents).toEqual([`onLanguage:${LANGUAGE_ID}`])
    expect(language).toMatchObject({ id: LANGUAGE_ID, extensions: ['.sight'] })
    expect(manifest.main).toBe('./dist/extension.js')
    expect(manifest.name).toBe('hindsight-vscode')
    expect((manifest.engines as Json).vscode).toBe('^1.90.0')
  })

  test('pins @types/vscode to the oldest VS Code it supports, as vsce requires', () => {
    const types = (manifest.devDependencies as Json)['@types/vscode'] as string

    expect(types).toBe('1.90.0')
  })

  test('declares the settings with the defaults and bounds the code uses', () => {
    const properties = (contributes.configuration as Json).properties as Record<string, Json>

    expect(properties['hindsight.maxSteps']).toMatchObject({
      default: DEFAULT_MAX_STEPS,
      minimum: MIN_STEPS,
      maximum: MAX_STEPS,
    })
    expect(properties['hindsight.studioUrl']!.default).toBe(DEFAULT_STUDIO_URL)
    expect(properties['hindsight.runOnSave']!.default).toBe(true)
    expect(properties['hindsight.codeLens']!.default).toBe(true)
  })
})

describe('TextMate grammar', () => {
  test('every pattern compiles as a regular expression', () => {
    const sources = objects(grammar).flatMap((o) =>
      ['match', 'begin', 'end'].flatMap((key) => (typeof o[key] === 'string' ? [o[key]] : [])),
    )

    expect(sources.length).toBeGreaterThan(20)
    for (const source of sources) expect(() => new RegExp(source as string)).not.toThrow()
  })

  test('every include points at a rule of the repository', () => {
    const repository = grammar.repository as Json
    const includes = objects(grammar)
      .map((o) => o.include)
      .filter((v): v is string => typeof v === 'string')

    for (const include of includes) {
      expect(include.startsWith('#')).toBe(true)
      expect(repository[include.slice(1)]).toBeDefined()
    }
  })

  test('highlights every reserved word of the language as a keyword', () => {
    const keywordRule = repositoryRule('keywords')
    const highlighted = objects(keywordRule)
      .filter((o) => typeof o.match === 'string')
      .flatMap((o) => words(o.match as string))

    expect([...highlighted].sort()).toEqual([...KEYWORDS].sort())
  })

  test('treats requires and ensures as keywords only in a function signature', () => {
    const contract = patternsNamed(
      repositoryRule('function-signature'),
      'keyword.other.contract.sight',
    )

    expect(contract.flatMap(words)).toEqual(['requires', 'ensures'])
    expect(JSON.stringify(repositoryRule('keywords'))).not.toContain('requires')
  })

  test('highlights exactly the builtin names of the core', () => {
    const functions = patternsNamed(repositoryRule('builtins'), 'support.function.builtin.sight')
    const constants = patternsNamed(repositoryRule('builtins'), 'support.constant.sight')

    expect([...functions.flatMap(words), ...constants.flatMap(words)].sort()).toEqual(
      [...BUILTIN_NAMES].sort(),
    )
  })

  test('recognizes interpolation and escapes in strings', () => {
    const strings = repositoryRule('strings')
    const [escape] = patternsNamed(strings, 'constant.character.escape.sight')
    const interpolation = repositoryRule('interpolation')

    for (const text of ['\\n', '\\{', '\\}', '\\"', '\\u{1F600}'])
      expect(new RegExp(`^(?:${escape})$`).test(text)).toBe(true)
    expect(new RegExp(`^(?:${escape})$`).test('\\q')).toBe(false)
    expect((strings.patterns as Json[]).some((p) => p.include === '#interpolation')).toBe(true)
    expect(interpolation.begin).toBe('\\{')
    expect((interpolation.patterns as Json[])[0]!.include).toBe('#expression')
  })

  test('takes bars as lambda parameters but not the pipe operator', () => {
    const lambda = new RegExp(repositoryRule('lambda').match as string)

    expect(lambda.exec('map(xs, |x, y| x + y)')?.[2]).toBe('x, y')
    expect(lambda.exec('let f = || 42')?.[2]).toBe('')
    expect(lambda.exec('xs |> map(|x| x * 2)')?.[2]).toBe('x')
    expect(lambda.test('xs |> sum')).toBe(false)
  })
})

describe('language configuration', () => {
  test('uses the line and nesting block comments of the language', () => {
    expect(languageConfiguration.comments).toEqual({
      lineComment: '//',
      blockComment: ['/*', '*/'],
    })
  })

  test('auto-closes braces inside strings too, for interpolation, but quotes only in code', () => {
    const pairs = languageConfiguration.autoClosingPairs as Json[]
    const brace = pairs.find((p) => p.open === '{')
    const quote = pairs.find((p) => p.open === '"')

    expect(brace).toEqual({ open: '{', close: '}' })
    expect(quote).toMatchObject({ close: '"', notIn: ['string', 'comment'] })
  })

  test('counts an interpolation as code, so quotes and brackets work inside it', () => {
    const [grammarContribution] = contributes.grammars as Json[]

    expect(grammarContribution!.tokenTypes).toEqual({ 'meta.embedded.line.sight': 'other' })
    expect(repositoryRule('interpolation').contentName).toBe('meta.embedded.line.sight')
  })
})
