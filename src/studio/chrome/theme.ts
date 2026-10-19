import type { ThemeSetting } from '../state/types'

/** The part of `document.documentElement` the theme switch touches. */
export interface ThemeRoot {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/**
 * Returns a function that applies the theme setting through `data-theme` on <html>. Light and dark
 * force the attribute; 'system' hands control back to whatever the page's host had set before the
 * first override (a hosting page may set `data-theme` itself), or removes the attribute if nothing
 * was set. While the setting stays 'system', the attribute is never touched.
 */
export function createThemeSwitch(root: ThemeRoot): (theme: ThemeSetting) => void {
  let hostTheme: string | null | undefined
  return (theme) => {
    if (theme !== 'system') {
      if (hostTheme === undefined) hostTheme = root.getAttribute('data-theme')
      root.setAttribute('data-theme', theme)
      return
    }
    if (hostTheme === undefined) return
    if (hostTheme === null) root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', hostTheme)
    hostTheme = undefined
  }
}
