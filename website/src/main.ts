import '@fontsource/barlow/latin-400.css'
import '@fontsource/barlow/latin-500.css'
import '@fontsource/barlow/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import './styles.css'
import {
  ASSETS,
  CHECKSUMS_URL,
  detectSystem,
  downloadUrl,
  fetchRelease,
  formatDate,
  formatSize,
  isIntelMac,
  SYSTEM_NAMES,
  type Asset,
  type ReleaseInfo,
  type System,
} from './download'

const SYSTEMS: readonly System[] = ['windows', 'mac', 'linux']

const DOWNLOAD_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 2v9m0 0 3.5-3.5M8 11 4.5 7.5M3 14h10"/></svg>'

function element<T extends HTMLElement>(tag: string, className?: string, text?: string): T {
  const node = document.createElement(tag) as T
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** The files for `system`, the visitor's preferred one first. */
function orderedAssets(system: System, intel: boolean): readonly Asset[] {
  const assets = ASSETS[system]
  return system === 'mac' && intel ? [...assets].reverse() : assets
}

function fileLink(asset: Asset, release: ReleaseInfo | null): HTMLAnchorElement {
  const link = element<HTMLAnchorElement>('a', 'file')
  link.href = downloadUrl(asset.name)
  const size = release?.sizes.get(asset.name)
  const text = element('span')
  text.append(element('b', undefined, asset.label))
  text.append(
    element('small', undefined, size ? `${asset.note} · ${formatSize(size)}` : asset.note),
  )
  const go = element('span', 'file-go')
  go.innerHTML = DOWNLOAD_ICON
  link.append(text, go)
  link.setAttribute('aria-label', `Download ${asset.label} (${asset.name})`)
  return link
}

function renderSystems(
  host: HTMLElement,
  yours: System | null,
  intel: boolean,
  release: ReleaseInfo | null,
): void {
  host.replaceChildren()
  const order = yours ? [yours, ...SYSTEMS.filter((system) => system !== yours)] : SYSTEMS
  for (const system of order) {
    const card = element(
      'article',
      `system reveal is-visible${system === yours ? ' is-yours' : ''}`,
    )
    const head = element('div', 'system-head')
    head.append(element('h3', undefined, SYSTEM_NAMES[system]))
    if (system === yours) head.append(element('span', 'badge', 'Your system'))
    const files = element('ul', 'system-files')
    for (const asset of orderedAssets(system, intel)) {
      const item = element('li')
      item.append(fileLink(asset, release))
      files.append(item)
    }
    card.append(head, files)
    host.append(card)
  }
}

function updatePrimary(yours: System | null, intel: boolean): void {
  const asset = yours ? orderedAssets(yours, intel)[0] : undefined
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-primary-download]')) {
    if (asset) link.href = downloadUrl(asset.name)
  }
  const label = document.querySelector('[data-primary-label]')
  if (label && yours) label.textContent = `Download for ${SYSTEM_NAMES[yours]}`
}

function updateReleaseText(release: ReleaseInfo | null): void {
  const line = document.querySelector('[data-release-line]')
  const eyebrow = document.querySelector('[data-release-eyebrow]')
  if (!release) return
  const date = formatDate(release.date)
  if (line) line.textContent = `${release.version} · Free and open source`
  if (eyebrow) eyebrow.textContent = date ? `${release.version} · ${date}` : release.version
}

function setUpCopyButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    const state = button.querySelector('.copy-state')
    const idle = state?.textContent ?? 'Copy'
    button.addEventListener('click', () => {
      const text = button.dataset.copy ?? ''
      navigator.clipboard?.writeText(text).then(
        () => {
          button.classList.add('is-copied')
          if (state) state.textContent = 'Copied'
          window.setTimeout(() => {
            button.classList.remove('is-copied')
            if (state) state.textContent = idle
          }, 1800)
        },
        () => {
          if (state) state.textContent = 'Press Ctrl+C'
        },
      )
    })
  }
}

function setUpReveals(): void {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -40px 0px', threshold: 0 },
  )
  for (const node of document.querySelectorAll('.reveal:not(.is-visible)')) observer.observe(node)
  // The last things on the page may never cross the margin above; at the bottom, show them all.
  const atBottom = () => {
    if (window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 80) return
    for (const node of document.querySelectorAll('.reveal:not(.is-visible)')) {
      node.classList.add('is-visible')
      observer.unobserve(node)
    }
  }
  window.addEventListener('scroll', atBottom, { passive: true })
}

/** The demo plays only while it can be seen. */
function setUpDemo(): void {
  const video = document.querySelector<HTMLVideoElement>('[data-demo]')
  if (!video) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    video.removeAttribute('autoplay')
    video.pause()
    video.controls = true
    return
  }
  new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting) void video.play().catch(() => undefined)
    else video.pause()
  }).observe(video)
}

async function setUpHero(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('[data-hero-canvas]')
  const host = document.querySelector<HTMLElement>('[data-hero]')
  if (!canvas || !host) return
  try {
    const { mountHero } = await import('./hero')
    mountHero(canvas, host)
  } catch {
    // No WebGL: the charms appear as a picture instead.
    host.classList.add('hero-still')
  }
}

async function setUpDownloads(): Promise<void> {
  const host = document.querySelector<HTMLElement>('[data-systems]')
  const checksums = document.querySelector<HTMLAnchorElement>('[data-checksums]')
  if (checksums) checksums.href = CHECKSUMS_URL
  const yours = detectSystem()
  let intel = false
  if (host) renderSystems(host, yours, intel, null)
  updatePrimary(yours, intel)
  const [release, isIntel] = await Promise.all([
    fetchRelease(AbortSignal.timeout(8000)),
    yours === 'mac' ? isIntelMac() : Promise.resolve(false),
  ])
  intel = isIntel
  if (host) renderSystems(host, yours, intel, release)
  updatePrimary(yours, intel)
  updateReleaseText(release)
}

setUpCopyButtons()
setUpReveals()
setUpDemo()
void setUpHero()
void setUpDownloads()
