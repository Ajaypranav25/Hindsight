import type { Example, PenPosition } from './state/types'

function parsePen(text: string | undefined): PenPosition {
  if (text === 'start' || text === 'end' || text === 'peak') return text
  const fraction = Number(text)
  return text !== undefined && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
    ? fraction
    : 'peak'
}

/**
 * Reads an example's header comments: `// title:`, `// summary:`, and optionally `// outcome: error`
 * and `// pen: start | end | peak | <fraction>`. The id is the file name without its numeric
 * prefix and extension.
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
    pen: parsePen(header('pen')),
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
