import { describe, expect, test, vi } from 'vitest'
import type { StudioActions } from '../state/types'
import {
  commandForKey,
  focusContextOf,
  getEditorCursorLine,
  isApplePlatform,
  NO_FOCUS,
  runCommand,
  runShortcutLabel,
  setEditorCursorLine,
  shortcutList,
  type FocusContext,
  type FocusTarget,
  type KeyInput,
} from './shortcuts'

function key(name: string, mods: Partial<KeyInput> = {}): KeyInput {
  return { key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods }
}

const EDITING: FocusContext = { ...NO_FOCUS, editable: true }
const ON_BUTTON: FocusContext = { ...NO_FOCUS, control: true }

describe('commandForKey', () => {
  test.each([
    ['F11', 'into'],
    ['F10', 'over'],
    ['F7', 'out'],
  ] as const)('%s steps %s forward, and back with Shift', (name, step) => {
    expect(commandForKey(key(name), NO_FOCUS)).toEqual({ kind: 'step', step, direction: 'forward' })
    expect(commandForKey(key(name, { shiftKey: true }), NO_FOCUS)).toEqual({
      kind: 'step',
      step,
      direction: 'backward',
    })
  })

  test('F8 continues in either direction', () => {
    expect(commandForKey(key('F8'), NO_FOCUS)).toEqual({ kind: 'continue', direction: 'forward' })
    expect(commandForKey(key('F8', { shiftKey: true }), EDITING)).toEqual({
      kind: 'continue',
      direction: 'backward',
    })
  })

  test('function keys work from inside the editor', () => {
    expect(commandForKey(key('F10'), EDITING)?.kind).toBe('step')
    expect(commandForKey(key('F9'), EDITING)).toEqual({ kind: 'toggle-breakpoint' })
  })

  test('Ctrl+Enter and Cmd+Enter run, even while typing', () => {
    expect(commandForKey(key('Enter', { ctrlKey: true }), EDITING)).toEqual({ kind: 'run' })
    expect(commandForKey(key('Enter', { metaKey: true }), NO_FOCUS)).toEqual({ kind: 'run' })
    expect(commandForKey(key('Enter'), NO_FOCUS)).toBeNull()
    expect(commandForKey(key('Enter', { ctrlKey: true, shiftKey: true }), NO_FOCUS)).toBeNull()
  })

  test('Home, End and Space act only outside text fields', () => {
    expect(commandForKey(key('Home'), NO_FOCUS)).toEqual({ kind: 'start' })
    expect(commandForKey(key('End'), NO_FOCUS)).toEqual({ kind: 'end' })
    expect(commandForKey(key(' '), NO_FOCUS)).toEqual({ kind: 'toggle-play' })
    expect(commandForKey(key('Home'), EDITING)).toBeNull()
    expect(commandForKey(key('End'), EDITING)).toBeNull()
    expect(commandForKey(key(' '), EDITING)).toBeNull()
  })

  test('Space leaves buttons alone, Home and End still work there', () => {
    expect(commandForKey(key(' '), ON_BUTTON)).toBeNull()
    expect(commandForKey(key('Home'), ON_BUTTON)).toEqual({ kind: 'start' })
  })

  test('modified keys and plain typing are never shortcuts', () => {
    expect(commandForKey(key('F10', { ctrlKey: true }), NO_FOCUS)).toBeNull()
    expect(commandForKey(key('Home', { altKey: true }), NO_FOCUS)).toBeNull()
    expect(commandForKey(key('Home', { shiftKey: true }), NO_FOCUS)).toBeNull()
    expect(commandForKey(key('F9', { shiftKey: true }), NO_FOCUS)).toBeNull()
    expect(commandForKey(key('a'), NO_FOCUS)).toBeNull()
    expect(commandForKey(key('a'), EDITING)).toBeNull()
  })

  test('dialogs switch every shortcut off', () => {
    const dialog: FocusContext = { ...NO_FOCUS, inDialog: true }
    expect(commandForKey(key('F10'), dialog)).toBeNull()
    expect(commandForKey(key('Enter', { ctrlKey: true }), dialog)).toBeNull()
  })
})

function fakeActions(): StudioActions {
  const names = [
    'setSource',
    'loadExample',
    'run',
    'extend',
    'seek',
    'stepNav',
    'continueNav',
    'stepInstruction',
    'jumpToStart',
    'jumpToEnd',
    'togglePlay',
    'stopPlay',
    'toggleBreakpoint',
    'selectFrame',
    'jumpToOrigin',
    'setWatch',
    'updateSettings',
    'dismissHint',
    'clearNotice',
  ] as const
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as unknown as StudioActions
}

describe('runCommand', () => {
  test('dispatches each command to its action', () => {
    const actions = fakeActions()
    runCommand({ kind: 'step', step: 'over', direction: 'backward' }, actions, null)
    runCommand({ kind: 'continue', direction: 'forward' }, actions, null)
    runCommand({ kind: 'start' }, actions, null)
    runCommand({ kind: 'end' }, actions, null)
    runCommand({ kind: 'toggle-play' }, actions, null)
    runCommand({ kind: 'run' }, actions, null)
    expect(actions.stepNav).toHaveBeenCalledWith('over', 'backward')
    expect(actions.continueNav).toHaveBeenCalledWith('forward')
    expect(actions.jumpToStart).toHaveBeenCalled()
    expect(actions.jumpToEnd).toHaveBeenCalled()
    expect(actions.togglePlay).toHaveBeenCalled()
    expect(actions.run).toHaveBeenCalled()
  })

  test('F9 toggles the cursor line, and does nothing without a cursor', () => {
    const actions = fakeActions()
    expect(runCommand({ kind: 'toggle-breakpoint' }, actions, null)).toBe(false)
    expect(actions.toggleBreakpoint).not.toHaveBeenCalled()
    expect(runCommand({ kind: 'toggle-breakpoint' }, actions, 7)).toBe(true)
    expect(actions.toggleBreakpoint).toHaveBeenCalledWith(7)
  })
})

function target(
  tagName: string,
  attrs: Record<string, string> = {},
  inside: readonly string[] = [],
  isContentEditable = false,
): FocusTarget {
  return {
    tagName,
    isContentEditable,
    getAttribute: (name) => attrs[name] ?? null,
    closest: (selector) => (inside.some((s) => selector.includes(s)) ? {} : null),
  }
}

describe('focusContextOf', () => {
  test('nothing focused', () => {
    expect(focusContextOf(null)).toEqual(NO_FOCUS)
  })

  test('text fields and the code editor are editable', () => {
    expect(focusContextOf(target('INPUT')).editable).toBe(true)
    expect(focusContextOf(target('INPUT', { type: 'range' })).editable).toBe(true)
    expect(focusContextOf(target('TEXTAREA')).editable).toBe(true)
    expect(focusContextOf(target('SELECT')).editable).toBe(true)
    expect(focusContextOf(target('DIV', {}, [], true)).editable).toBe(true)
    expect(focusContextOf(target('DIV', {}, ['.cm-editor'])).editable).toBe(true)
  })

  test('buttons, checkboxes and tabs are controls, not text fields', () => {
    expect(focusContextOf(target('BUTTON'))).toEqual({ ...NO_FOCUS, control: true })
    expect(focusContextOf(target('INPUT', { type: 'checkbox' }))).toEqual({
      ...NO_FOCUS,
      control: true,
    })
    expect(focusContextOf(target('DIV', { role: 'tab' })).control).toBe(true)
    expect(focusContextOf(target('CANVAS', { role: 'slider' }))).toEqual(NO_FOCUS)
  })

  test('anything inside a dialog or menu', () => {
    expect(focusContextOf(target('BUTTON', {}, ['[role="dialog"]'])).inDialog).toBe(true)
    expect(focusContextOf(target('BUTTON', {}, ['[role="menu"]'])).inDialog).toBe(true)
  })

  test('an open modal dialog switches shortcuts off wherever focus is', () => {
    const open = { querySelector: (s: string) => (s.includes('aria-modal') ? {} : null) }
    const closed = { querySelector: () => null }
    expect(focusContextOf(null, open).inDialog).toBe(true)
    expect(focusContextOf(target('BODY'), open).inDialog).toBe(true)
    expect(focusContextOf(target('BODY'), closed).inDialog).toBe(false)
    expect(commandForKey(key('F11'), focusContextOf(null, open))).toBeNull()
  })

  test('Home and End belong to tab strips and sliders that handle them', () => {
    const onTab = focusContextOf(target('BUTTON', { role: 'tab' }, ['[role="tablist"]']))
    expect(onTab.keyWidget).toBe(true)
    expect(commandForKey(key('Home'), onTab)).toBeNull()
    expect(commandForKey(key('End'), onTab)).toBeNull()
    expect(commandForKey(key('F11'), onTab)).toEqual({
      kind: 'step',
      step: 'into',
      direction: 'forward',
    })
    const onSlider = focusContextOf(target('CANVAS', { role: 'slider' }, ['[role="slider"]']))
    expect(commandForKey(key('End'), onSlider)).toBeNull()
    expect(focusContextOf(target('BUTTON', {}, ['[role="toolbar"]'])).keyWidget).toBe(false)
  })
})

describe('editor cursor registry', () => {
  test('stores valid lines and clears otherwise', () => {
    setEditorCursorLine(12)
    expect(getEditorCursorLine()).toBe(12)
    setEditorCursorLine(0)
    expect(getEditorCursorLine()).toBeNull()
    setEditorCursorLine(3)
    setEditorCursorLine(null)
    expect(getEditorCursorLine()).toBeNull()
  })
})

describe('labels', () => {
  test('platform-specific run label', () => {
    expect(isApplePlatform('MacIntel')).toBe(true)
    expect(isApplePlatform('macOS')).toBe(true)
    expect(isApplePlatform('Win32')).toBe(false)
    expect(runShortcutLabel(true)).toBe('⌘ Enter')
    expect(runShortcutLabel(false)).toBe('Ctrl+Enter')
  })

  test('the help list covers every shortcut', () => {
    const keys = shortcutList(false).flatMap((item) => item.keys)
    for (const k of ['Ctrl+Enter', 'F11', 'Shift+F11', 'F10', 'F7', 'F8', 'F9', 'Home', 'Space'])
      expect(keys).toContain(k)
  })
})
