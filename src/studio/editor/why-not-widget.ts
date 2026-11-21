/**
 * "Why didn't this run?" inside the editor (ARCHITECTURE §7.10, §11.3): a block widget directly
 * under the asked line, laid out from the explanation's structured fields: the guard's condition,
 * its value at the decision step and the operands with where they were set. Focus moves into it
 * when it opens; Escape (or Close) closes it and gives focus back to the editor.
 */
import { type EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import type { WhyNot, WhyNotOperand } from '../../core/index'
import { formatCount } from '../lib/format'
import { type GuardDisplay, whyNotDisplay } from './lab-lines'
import { studioActions } from './studio-field'

/** The explanation to show: line `line` of the document, from a run of `length` steps. */
export interface WhyNotSpec {
  readonly line: number
  readonly why: WhyNot
  readonly length: number
}

export const setWhyNot = StateEffect.define<WhyNotSpec | null>()

interface FieldValue {
  readonly spec: WhyNotSpec | null
  readonly decorations: DecorationSet
}

const EMPTY: FieldValue = { spec: null, decorations: Decoration.none }

function decorate(state: EditorState, spec: WhyNotSpec | null): FieldValue {
  if (spec === null || spec.line < 1 || spec.line > state.doc.lines) return EMPTY
  const widget = Decoration.widget({ widget: new WhyNotWidget(spec), block: true, side: 1 })
  return { spec, decorations: Decoration.set([widget.range(state.doc.line(spec.line).to)]) }
}

/** The open explanation; an edit closes it, since its lines no longer match the recording. */
export const whyNotField = StateField.define<FieldValue>({
  create: () => EMPTY,
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setWhyNot)) return decorate(tr.state, effect.value)
    return tr.docChanged ? EMPTY : value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/** The effects that show `spec` (none when it is already shown). */
export function whyNotEffects(state: EditorState, spec: WhyNotSpec | null): StateEffect<unknown>[] {
  return state.field(whyNotField).spec === spec ? [] : [setWhyNot.of(spec)]
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  node.append(...children)
  return node
}

const code = (text: string) => el('code', 'ed-why-code', text)
const value = (text: string) => el('strong', 'ed-why-value', text)
const step = (time: number) => `step ${formatCount(time)}`

function operandNodes(operand: WhyNotOperand): (Node | string)[] {
  const nodes: (Node | string)[] = [code(operand.name), ' was ', value(operand.value)]
  if (operand.origin !== null) {
    const where = operand.origin.line === null ? '' : ` (line ${operand.origin.line})`
    nodes.push(`, set at ${step(operand.origin.time)}${where}`)
  }
  return nodes
}

/** "`if total > 80` was false at step 412 because `total` was 72, set at step 410 (line 2)." */
function guardParagraph(guard: GuardDisplay): HTMLParagraphElement {
  const when =
    guard.checks > 1
      ? ` at ${step(guard.time)}, the last of ${formatCount(guard.checks)} checks`
      : ` at ${step(guard.time)}`
  const nodes: (Node | string)[] = [code(guard.code), ' was ', value(guard.value), when]
  if (guard.meaning !== '') nodes.push(guard.meaning)
  guard.operands.forEach((operand, i) => {
    nodes.push(i === 0 ? ' because ' : '; ', ...operandNodes(operand))
  })
  nodes.push('.')
  return el('p', 'ed-why-text', ...nodes)
}

class WhyNotWidget extends WidgetType {
  private focused = false

  constructor(readonly spec: WhyNotSpec) {
    super()
  }

  override eq(other: WhyNotWidget): boolean {
    return other.spec === this.spec
  }

  toDOM(view: EditorView): HTMLElement {
    const display = whyNotDisplay(this.spec.why)
    const root = el('div', 'ed-why')
    root.setAttribute('role', 'group')
    root.setAttribute('aria-label', display.title)
    root.contentEditable = 'false'
    root.tabIndex = -1
    root.append(el('p', 'ed-why-label', display.title))
    if (display.sentence !== null) root.append(el('p', 'ed-why-text', display.sentence))
    if (display.guard !== null) root.append(guardParagraph(display.guard))
    root.append(this.tools(view, display))
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      this.close(view)
    })
    if (!this.focused) {
      this.focused = true
      // Not yet in the document: focus once CodeMirror has placed it.
      setTimeout(() => {
        if (root.isConnected) root.focus({ preventScroll: true })
      }, 0)
    }
    return root
  }

  private tools(view: EditorView, display: ReturnType<typeof whyNotDisplay>): HTMLElement {
    const tools = el('div', 'ed-why-tools')
    const seek = (time: number) => view.state.facet(studioActions)?.seek(time)
    const button = (label: string, onClick: () => void) => {
      const node = el('button', 'ch-button ch-button-small', label)
      node.type = 'button'
      node.addEventListener('click', onClick)
      tools.append(node)
    }
    const { decision, origin } = display
    if (decision !== null) button(decision.label, () => seek(decision.time))
    if (origin !== null) {
      button('Go to where it was set', () => seek(Math.min(origin.time + 1, this.spec.length)))
    }
    button('Close', () => this.close(view))
    return tools
  }

  private close(view: EditorView): void {
    view.state.facet(studioActions)?.closeWhyNot()
    view.focus()
  }

  override ignoreEvent(): boolean {
    return true
  }
}
