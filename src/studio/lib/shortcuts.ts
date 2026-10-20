/**
 * Keyboard shortcuts: a pure mapping from key presses to studio commands, the focus rules that
 * keep shortcuts from stealing typing, and a tiny registry the editor publishes its cursor line to
 * (so F9 can toggle a breakpoint on it).
 */
import type { Direction, StepKind } from '../../core/api-types'
import type { StudioActions } from '../state/types'

export type ShortcutCommand =
  | { readonly kind: 'step'; readonly step: StepKind; readonly direction: Direction }
  | { readonly kind: 'continue'; readonly direction: Direction }
  | { readonly kind: 'start' }
  | { readonly kind: 'end' }
  | { readonly kind: 'toggle-play' }
  | { readonly kind: 'toggle-breakpoint' }
  | { readonly kind: 'run' }

/** The parts of a KeyboardEvent the mapping reads. */
export interface KeyInput {
  readonly key: string
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
}

/** Where keyboard focus is, as far as shortcuts care. */
export interface FocusContext {
  /** A text field, select, slider or the code editor: keys there belong to the field. */
  readonly editable: boolean
  /** A button, link, checkbox, tab or menu item: Space activates it. */
  readonly control: boolean
  /** Inside a dialog or popover, or a modal dialog is open: shortcuts are off. */
  readonly inDialog: boolean
  /** Inside a widget that moves with Home, End and the arrows itself (tabs, sliders, lists). */
  readonly keyWidget: boolean
}

export const NO_FOCUS: FocusContext = {
  editable: false,
  control: false,
  inDialog: false,
  keyWidget: false,
}

const STEP_KEYS: Readonly<Record<string, StepKind>> = { F11: 'into', F10: 'over', F7: 'out' }

/** The command for a key press, or null when the key is not a shortcut in this focus context. */
export function commandForKey(input: KeyInput, focus: FocusContext): ShortcutCommand | null {
  if (focus.inDialog) return null
  const mod = input.ctrlKey || input.metaKey
  if (input.key === 'Enter' && mod && !input.altKey && !input.shiftKey) return { kind: 'run' }
  if (mod || input.altKey) return null
  const direction: Direction = input.shiftKey ? 'backward' : 'forward'
  const step = STEP_KEYS[input.key]
  if (step) return { kind: 'step', step, direction }
  if (input.key === 'F8') return { kind: 'continue', direction }
  if (input.shiftKey) return null
  if (input.key === 'F9') return { kind: 'toggle-breakpoint' }
  if (focus.editable) return null
  if (input.key === 'Home' && !focus.keyWidget) return { kind: 'start' }
  if (input.key === 'End' && !focus.keyWidget) return { kind: 'end' }
  if (input.key === ' ' && !focus.control) return { kind: 'toggle-play' }
  return null
}

/** Carries out a command; returns false when it could not apply (F9 without an editor cursor). */
export function runCommand(
  command: ShortcutCommand,
  actions: StudioActions,
  cursorLine: number | null,
): boolean {
  switch (command.kind) {
    case 'step':
      actions.stepNav(command.step, command.direction)
      return true
    case 'continue':
      actions.continueNav(command.direction)
      return true
    case 'start':
      actions.jumpToStart()
      return true
    case 'end':
      actions.jumpToEnd()
      return true
    case 'toggle-play':
      actions.togglePlay()
      return true
    case 'toggle-breakpoint':
      if (cursorLine === null) return false
      actions.toggleBreakpoint(cursorLine)
      return true
    case 'run':
      void actions.run()
      return true
  }
}

/** The DOM surface `focusContextOf` reads (an Element satisfies it). */
export interface FocusTarget {
  readonly tagName: string
  readonly isContentEditable?: boolean
  getAttribute(name: string): string | null
  closest(selector: string): unknown
}

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'number',
  'email',
  'url',
  'password',
  'tel',
  'range',
  'date',
  'time',
])
const CONTROL_ROLES = new Set([
  'button',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
  'link',
])
const DIALOG_SELECTOR = '[role="dialog"], [role="menu"], [role="alertdialog"], dialog'
/**
 * Composite widgets whose own key handlers use Home and End (the strip chart slider, the panel
 * tab strip). The transport toolbar is not one: its buttons advertise Home and End as shortcuts.
 */
const KEY_WIDGET_SELECTOR = '[role="tablist"], [role="listbox"], [role="menu"], [role="slider"]'
const MODAL_SELECTOR = '[aria-modal="true"]'

/** The document surface `focusContextOf` reads to see whether a modal dialog is open. */
export interface ModalRoot {
  querySelector(selector: string): unknown
}

/**
 * Classifies the focused element (null or a non-element when nothing is focused). With `root`,
 * an open `aria-modal` dialog switches shortcuts off even when focus has fallen out of it (a click
 * on its non-focusable title moves focus to the body).
 */
export function focusContextOf(target: FocusTarget | null, root?: ModalRoot): FocusContext {
  const modal = root ? root.querySelector(MODAL_SELECTOR) !== null : false
  if (!target || typeof target.tagName !== 'string')
    return modal ? { ...NO_FOCUS, inDialog: true } : NO_FOCUS
  const tag = target.tagName.toLowerCase()
  const role = target.getAttribute('role')
  const type = (target.getAttribute('type') ?? 'text').toLowerCase()
  const editable =
    target.isContentEditable === true ||
    tag === 'textarea' ||
    tag === 'select' ||
    (tag === 'input' && TEXT_INPUT_TYPES.has(type)) ||
    role === 'textbox' ||
    role === 'combobox' ||
    target.closest('.cm-editor') !== null
  const control =
    tag === 'button' ||
    tag === 'a' ||
    tag === 'summary' ||
    tag === 'input' ||
    (role !== null && CONTROL_ROLES.has(role))
  return {
    editable,
    control,
    inDialog: modal || target.closest(DIALOG_SELECTOR) !== null,
    keyWidget: target.closest(KEY_WIDGET_SELECTOR) !== null,
  }
}

// --- editor cursor registry -----------------------------------------------------------------

let editorCursorLine: number | null = null

/** The editor publishes its cursor's 1-based line here (null when it has no cursor). */
export function setEditorCursorLine(line: number | null): void {
  editorCursorLine = line !== null && Number.isInteger(line) && line >= 1 ? line : null
}

export function getEditorCursorLine(): number | null {
  return editorCursorLine
}

// --- labels ---------------------------------------------------------------------------------

/** True on Apple platforms, where the modifier is ⌘. */
export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** "Ctrl+Enter" or "⌘ Enter". */
export function runShortcutLabel(apple: boolean): string {
  return apple ? '⌘ Enter' : 'Ctrl+Enter'
}

export function currentPlatform(): string {
  const nav = globalThis.navigator as
    (Navigator & { userAgentData?: { platform?: string } }) | undefined
  return nav?.userAgentData?.platform ?? nav?.platform ?? nav?.userAgent ?? ''
}

export interface ShortcutHelp {
  readonly keys: readonly string[]
  readonly action: string
}

/** Every shortcut, for the help dialog. */
export function shortcutList(apple: boolean): readonly ShortcutHelp[] {
  return [
    { keys: [runShortcutLabel(apple)], action: 'Run the program' },
    { keys: ['F11', 'Shift+F11'], action: 'Step into, forward / back' },
    { keys: ['F10', 'Shift+F10'], action: 'Step over, forward / back' },
    { keys: ['F7', 'Shift+F7'], action: 'Step out, forward / back' },
    { keys: ['F8', 'Shift+F8'], action: 'Continue to the next / previous breakpoint' },
    { keys: ['F9'], action: 'Toggle a breakpoint on the cursor line' },
    { keys: ['Home', 'End'], action: 'Jump to the start / end of the run' },
    { keys: ['Space'], action: 'Play or pause, statement by statement' },
    { keys: ['←', '→'], action: 'Step into back / forward (strip chart focused)' },
    { keys: ['Shift+←', 'Shift+→'], action: 'Step over back / forward (strip chart focused)' },
  ]
}
