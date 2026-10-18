/**
 * Turns Vite's built index.html into one self-contained page fragment: the bundled script and
 * stylesheet are inlined, and the document wrappers (doctype, html, head, body, charset and
 * viewport metas) are dropped because the publishing host supplies its own skeleton.
 */
export type AssetReader = (publicPath: string) => string | undefined

const SCRIPT_TAG = /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g
const STYLESHEET_TAG = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g
const PRELOAD_TAG = /<link\b[^>]*\brel="modulepreload"[^>]*>\s*/g

/** Keeps inlined code from closing its own element early. */
function escapeClosing(code: string, tag: 'script' | 'style'): string {
  return code.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}

function isLocal(path: string): boolean {
  return !/^[a-z]+:\/\//i.test(path) && !path.startsWith('//')
}

export function inlinePage(html: string, readAsset: AssetReader): string {
  const missing: string[] = []
  const read = (path: string): string => {
    const content = readAsset(path)
    if (content === undefined) missing.push(path)
    return content ?? ''
  }

  let page = html.replace(PRELOAD_TAG, '')
  page = page.replace(SCRIPT_TAG, (tag, src: string) =>
    isLocal(src) ? `<script type="module">${escapeClosing(read(src), 'script')}</script>` : tag,
  )
  page = page.replace(STYLESHEET_TAG, (tag, href: string) =>
    isLocal(href) ? `<style>${escapeClosing(read(href), 'style')}</style>` : tag,
  )
  if (missing.length > 0) throw new Error(`inlinePage: missing built assets ${missing.join(', ')}`)

  const head = page.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? ''
  const body = page.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? page
  const headContent = head
    .replace(/<meta\s+charset=[^>]*>\s*/i, '')
    .replace(/<meta\s+name="viewport"[^>]*>\s*/i, '')
  return `${headContent.trim()}\n${body.trim()}\n`
}
