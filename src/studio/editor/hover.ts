/** Hovering an identifier shows its value at the pen, with a jump to where it was set. */
import { hoverTooltip, type EditorView, type Tooltip } from '@codemirror/view'
import { formatValue, truncate } from '../lib/format'
import { selectedFrame } from '../state/selectors'
import type { StudioActions } from '../state/types'
import { identifierAt } from './highlight'
import { resolveName, type ResolvedName } from './resolve'
import { liveStudio, studioActions } from './studio-field'

const HOVER_VALUE_CHARS = 80
const HOVER_DELAY_MS = 250

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** The tooltip body: kind, "name = value", and the origin action. */
export function hoverContent(resolved: ResolvedName, actions: StudioActions | null): HTMLElement {
  const root = element('div', 'ed-hover')
  root.append(element('span', 'ed-hover-kind', resolved.kind))
  const value = truncate(formatValue(resolved.value), HOVER_VALUE_CHARS)
  root.append(element('code', 'ed-hover-value', `${resolved.name} = ${value}`))
  if (actions) {
    const origin = element('button', 'ed-hover-origin', '⟲ origin') as HTMLButtonElement
    origin.type = 'button'
    origin.title = `Jump to where ${resolved.name} was set`
    origin.setAttribute('aria-label', `Jump to where ${resolved.name} was set`)
    origin.addEventListener('click', () => actions.jumpToOrigin(resolved.target, resolved.name))
    root.append(origin)
  }
  return root
}

function hoverAt(view: EditorView, pos: number): Tooltip | null {
  const studio = liveStudio(view.state)
  if (!studio?.view) return null
  const token = identifierAt(view.state.doc.toString(), pos)
  if (!token) return null
  const frame = selectedFrame(studio.view, studio.selectedFrameUid)
  const resolved = resolveName(String(token.value), studio.view, frame)
  if (!resolved) return null
  const actions = view.state.facet(studioActions)
  return {
    pos: token.start,
    end: token.end,
    above: true,
    create: () => ({ dom: hoverContent(resolved, actions) }),
  }
}

export const valueHover = hoverTooltip(hoverAt, { hoverTime: HOVER_DELAY_MS })
