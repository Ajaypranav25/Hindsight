/**
 * The conformance corpus (docs/ARCHITECTURE.md §10.2): every tests/lang/**\/*.sight file is checked
 * against its annotations through the public API, with maxSteps 5,000,000 and seed 42.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { checkSource, type ConformanceApi } from '../src/conformance/check'
import { compile, record, run } from '../src/core/index'

const CORPUS_DIR = fileURLToPath(new URL('./lang', import.meta.url))

/** Corpus files relative to tests/lang, with forward slashes, sorted. */
function corpusFiles(): string[] {
  return readdirSync(CORPUS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.sight'))
    .map((path) => path.split(sep).join('/'))
    .sort()
}

const api: ConformanceApi = { compile, run, record }
const files = corpusFiles()

describe('conformance corpus', () => {
  test('the corpus is present', () => {
    expect(files.length).toBeGreaterThanOrEqual(250)
  })

  test.each(files)('%s', (file) => {
    // Arrange
    const source = readFileSync(join(CORPUS_DIR, file), 'utf8')

    // Act
    const result = checkSource(source, api)

    // Assert
    expect(result.failures).toEqual([])
    expect(result.ok).toBe(true)
  })
})
