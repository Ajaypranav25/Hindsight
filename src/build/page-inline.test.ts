import { describe, expect, test } from 'vitest'
import { inlinePage } from './page-inline'

const BUILT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Hindsight Studio</title>
    <meta name="claude:viewport-fit-sides" content="cover" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow&display=swap" />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-def.js">
    <link rel="stylesheet" crossorigin href="/assets/index-123.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`

const ASSETS: Record<string, string> = {
  '/assets/index-abc.js': 'console.info("</script>"); run()',
  '/assets/index-123.css': 'body{color:red}',
}

describe('inlinePage', () => {
  test('inlines the bundle and stylesheet and drops document wrappers', () => {
    const page = inlinePage(BUILT, (path) => ASSETS[path])
    expect(page.startsWith('<title>Hindsight Studio</title>')).toBe(true)
    expect(page).not.toMatch(/<!doctype|<html|<head|<body|charset|name="viewport"|modulepreload/i)
    expect(page).toContain('<style>body{color:red}</style>')
    expect(page).toContain('<script type="module">console.info("<\\/script>"); run()</script>')
    expect(page).toContain('<div id="root"></div>')
    expect(page).toContain('fonts.googleapis.com')
    expect(page).toContain('claude:viewport-fit-sides')
  })

  test('fails loudly when a built asset is missing', () => {
    expect(() => inlinePage(BUILT, () => undefined)).toThrow(/missing built assets/)
  })
})
