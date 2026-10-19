import type { ThemeSetting } from '../state/types'

/** The part of `document.documentElement` the theme switch touches. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/** Forces light or dark through `data-theme` on <html>; 'system' follows the OS preference. */
export function applyTheme(theme: ThemeSetting, root: ThemeRoot): void {
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}
