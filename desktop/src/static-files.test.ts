import { join, resolve, sep } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  CONTENT_SECURITY_POLICY,
  contentTypeOf,
  resolveStudioFile,
  responseHeaders,
} from './static-files'

const ROOT = resolve('studio-root')

describe('resolveStudioFile', () => {
  test('maps app://studio paths to files in the studio folder', () => {
    expect(resolveStudioFile(ROOT, 'app://studio/index.html')).toEqual({
      ok: true,
      file: join(ROOT, 'index.html'),
    })
    expect(resolveStudioFile(ROOT, 'app://studio/assets/index-abc.js?v=2#x')).toEqual({
      ok: true,
      file: join(ROOT, 'assets', 'index-abc.js'),
    })
  })

  test('serves index.html for a folder', () => {
    expect(resolveStudioFile(ROOT, 'app://studio/')).toEqual({
      ok: true,
      file: join(ROOT, 'index.html'),
    })
    expect(resolveStudioFile(ROOT, 'app://studio')).toEqual({
      ok: true,
      file: join(ROOT, 'index.html'),
    })
  })

  test('decodes percent-escapes in file names', () => {
    expect(resolveStudioFile(ROOT, 'app://studio/fonts/My%20Font.woff2')).toEqual({
      ok: true,
      file: join(ROOT, 'fonts', 'My Font.woff2'),
    })
  })

  test('never leaves the studio folder', () => {
    // Arrange: dot segments the URL parser removes, and escaped ones only decoding reveals.
    const urls = [
      'app://studio/../secret.txt',
      'app://studio/%2e%2e/secret.txt',
      'app://studio/assets/%2e%2e/%2e%2e/secret.txt',
      'app://studio/..%2fsecret.txt',
      'app://studio/assets/..%2f..%2fsecret.txt',
      'app://studio/..%5csecret.txt',
      'app://studio/%2e%2e',
    ]

    // Act
    const resolved = urls.map((url) => resolveStudioFile(ROOT, url))

    // Assert
    for (const [index, file] of resolved.entries()) {
      if (file.ok) expect(file.file.startsWith(`${ROOT}${sep}`), urls[index]).toBe(true)
    }
    expect(resolveStudioFile(ROOT, 'app://studio/..%2fsecret.txt')).toEqual({
      ok: false,
      status: 404,
    })
  })

  test('refuses malformed paths and other hosts', () => {
    expect(resolveStudioFile(ROOT, 'app://studio/%E0%A4%A')).toEqual({ ok: false, status: 400 })
    expect(resolveStudioFile(ROOT, 'app://studio/index.html%00.js')).toEqual({
      ok: false,
      status: 400,
    })
    expect(resolveStudioFile(ROOT, 'app://studio/C:%5cWindows%5cwin.ini')).toEqual({
      ok: false,
      status: 400,
    })
    expect(resolveStudioFile(ROOT, 'app://studio/..%5csecret.txt')).toEqual({
      ok: false,
      status: 400,
    })
    expect(resolveStudioFile(ROOT, 'app://other/index.html')).toEqual({ ok: false, status: 404 })
    expect(resolveStudioFile(ROOT, 'https://studio/index.html')).toEqual({ ok: false, status: 404 })
    expect(resolveStudioFile(ROOT, 'no url at all')).toEqual({ ok: false, status: 400 })
  })
})

describe('responses', () => {
  test('carry the content type the browser needs for each kind of file', () => {
    expect(contentTypeOf('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeOf('assets/index.JS')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeOf('a.mjs')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeOf('a.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeOf('a.js.map')).toBe('application/json; charset=utf-8')
    expect(contentTypeOf('a.json')).toBe('application/json; charset=utf-8')
    expect(contentTypeOf('font.woff2')).toBe('font/woff2')
    expect(contentTypeOf('icon.svg')).toBe('image/svg+xml')
    expect(contentTypeOf('vm.wasm')).toBe('application/wasm')
    expect(contentTypeOf('README')).toBe('application/octet-stream')
  })

  test('carry the Content-Security-Policy and forbid sniffing', () => {
    const headers = responseHeaders('text/html; charset=utf-8')

    expect(headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(headers['Content-Security-Policy']).toBe(CONTENT_SECURITY_POLICY)
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
  })

  test('the policy keeps scripts to the app and everything off the network', () => {
    const directives = new Map(
      CONTENT_SECURITY_POLICY.split('; ').map((directive) => {
        const [name = '', ...sources] = directive.split(' ')
        return [name, sources.join(' ')]
      }),
    )

    expect(directives.get('default-src')).toBe("'self'")
    expect(directives.get('script-src')).toBe("'self'")
    expect(directives.get('connect-src')).toBe("'self'")
    expect(directives.get('object-src')).toBe("'none'")
    expect(directives.get('frame-ancestors')).toBe("'none'")
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:|unsafe-eval|\*/)
  })
})
