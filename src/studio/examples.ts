import type { Example } from './state/types'

/**
 * Reads an example's header comments: `// title:`, `// summary:` and optionally `// outcome: error`.
 * The id is the file name without its numeric prefix and extension.
 */
export function parseExample(path: string, source: string): Example {
  const file = path.split('/').pop() ?? path
  const id = file.replace(/\.sight$/, '').replace(/^\d+-/, '')
  const header = (key: string) => source.match(new RegExp(`^// ${key}:\\s*(.+)$`, 'm'))?.[1]?.trim()
  return {
    id,
    title: header('title') ?? id,
    summary: header('summary') ?? '',
    source,
    outcome: header('outcome') === 'error' ? 'error' : 'finished',
  }
}

const modules = import.meta.glob<string>('/examples/*.sight', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** The gallery, ordered by file name. */
export const EXAMPLES: readonly Example[] = Object.keys(modules)
  .sort()
  .map((path) => parseExample(path, modules[path]!))
