/**
 * The npm package (hindsight-lang): what `npm publish` ships is the bundled CLI alone, so the
 * manifest must name it, carry no runtime dependencies and be publishable.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

interface Manifest {
  readonly name: string
  readonly private?: boolean
  readonly bin: Readonly<Record<string, string>>
  readonly files: readonly string[]
  readonly dependencies?: Readonly<Record<string, string>>
  readonly publishConfig: Readonly<Record<string, unknown>>
  readonly repository: { readonly url: string }
  readonly homepage: string
  readonly bugs: { readonly url: string }
  readonly keywords: readonly string[]
}

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as Manifest

describe('the npm package', () => {
  test('is published as hindsight-lang with a hindsight command', () => {
    expect(manifest.name).toBe('hindsight-lang')
    expect(manifest.private).toBeUndefined()
    expect(manifest.bin).toEqual({ hindsight: 'dist/cli/hindsight.mjs' })
  })

  test('ships only the CLI bundle and installs no runtime dependencies', () => {
    expect(manifest.files).toEqual(['dist/cli/hindsight.mjs'])
    expect(manifest.dependencies ?? {}).toEqual({})
  })

  test('publishes publicly with provenance and links back to the project', () => {
    expect(manifest.publishConfig).toEqual({ access: 'public', provenance: true })
    expect(manifest.repository.url).toContain('github.com/Ajaypranav25/Hindsight')
    expect(manifest.homepage).toBe('https://hindsight-two.vercel.app')
    expect(manifest.bugs.url).toContain('/issues')
    expect(manifest.keywords.length).toBeGreaterThan(0)
  })
})
