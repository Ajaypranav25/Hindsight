/**
 * Downloads: which system the visitor is on, and the latest release's files. The installers have
 * version-less names, so `releases/latest/download/<name>` always serves the newest one; GitHub's
 * API adds the version, the date and the sizes when it answers (and the page works when it does
 * not).
 */

export const REPOSITORY = 'https://github.com/Ajaypranav25/Hindsight'
const LATEST = `${REPOSITORY}/releases/latest/download`
const API = 'https://api.github.com/repos/Ajaypranav25/Hindsight/releases/latest'

export type System = 'windows' | 'mac' | 'linux'

export interface Asset {
  readonly name: string
  readonly label: string
  readonly note: string
}

export const ASSETS: Record<System, readonly Asset[]> = {
  windows: [
    { name: 'Hindsight-Setup-x64.exe', label: 'Installer', note: 'Windows 10 and 11, 64-bit' },
  ],
  mac: [
    { name: 'Hindsight-mac-arm64.dmg', label: 'Apple silicon', note: 'M1 and later' },
    { name: 'Hindsight-mac-x64.dmg', label: 'Intel', note: 'Macs with an Intel chip' },
  ],
  linux: [
    { name: 'Hindsight-linux-amd64.deb', label: '.deb', note: 'Debian, Ubuntu' },
    { name: 'Hindsight-linux-x86_64.AppImage', label: 'AppImage', note: 'Any distribution' },
  ],
}

export const SYSTEM_NAMES: Record<System, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
}

export function downloadUrl(name: string): string {
  return `${LATEST}/${name}`
}

export const CHECKSUMS_URL = downloadUrl('SHA256SUMS.txt')
export const RELEASES_URL = `${REPOSITORY}/releases/latest`

interface NavigatorWithHints {
  readonly userAgent: string
  readonly platform?: string
  readonly userAgentData?: {
    readonly platform?: string
    getHighEntropyValues?(hints: string[]): Promise<{ architecture?: string }>
  }
}

/** The visitor's system, or null on phones, tablets and anything unrecognised. */
export function detectSystem(nav: NavigatorWithHints = navigator): System | null {
  const hint = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent}`
  if (/android|iphone|ipad|ipod/i.test(hint)) return null
  if (/win/i.test(hint)) return 'windows'
  if (/mac/i.test(hint)) return 'mac'
  if (/linux|x11|cros/i.test(hint)) return 'linux'
  return null
}

/**
 * Whether this Mac has an Intel chip. Only Chromium browsers can tell; everyone else gets Apple
 * silicon first, which is what Macs have shipped with since 2020.
 */
export async function isIntelMac(nav: NavigatorWithHints = navigator): Promise<boolean> {
  try {
    const values = await nav.userAgentData?.getHighEntropyValues?.(['architecture'])
    return values?.architecture === 'x86'
  } catch {
    return false
  }
}

export interface ReleaseInfo {
  readonly version: string
  readonly date: string
  readonly sizes: ReadonlyMap<string, number>
}

/** The latest release as GitHub reports it, or null when the API cannot be reached. */
export async function fetchRelease(signal?: AbortSignal): Promise<ReleaseInfo | null> {
  try {
    const response = await fetch(API, {
      signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      tag_name?: unknown
      published_at?: unknown
      assets?: { name?: unknown; size?: unknown }[]
    }
    if (typeof body.tag_name !== 'string') return null
    const sizes = new Map<string, number>()
    for (const asset of body.assets ?? [])
      if (typeof asset.name === 'string' && typeof asset.size === 'number')
        sizes.set(asset.name, asset.size)
    const date = typeof body.published_at === 'string' ? body.published_at : ''
    return { version: body.tag_name, date, sizes }
  } catch {
    return null
  }
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

export function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}
