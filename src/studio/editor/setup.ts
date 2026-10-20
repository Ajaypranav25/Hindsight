/** The editor's extension list: a basicSetup-like core plus the Hindsight extensions. */
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { lintKeymap } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Annotation, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import type { StudioActions } from '../state/types'
import { penDecorations } from './decorations'
import { breakpointGutterExtension, heatGutterExtension } from './gutters'
import { valueHover } from './hover'
import { hindsightLanguage } from './language'
import { studioActions, studioField, studioOf } from './studio-field'
import { hindsightTheme } from './theme'

/** Marks transactions that apply the store's source, so they are not echoed back to it. */
export const fromStore = Annotation.define<boolean>()

export interface SetupOptions {
  readonly actions: StudioActions
  /** Called with the full text after every user edit. */
  readonly onUserEdit: (text: string) => void
  /** Called with the cursor's 1-based line whenever it may have moved. */
  readonly onCursorLine: (line: number) => void
}

function listeners(options: SetupOptions): Extension {
  return EditorView.updateListener.of((update) => {
    const fromUser =
      update.docChanged && update.transactions.some((tr) => !tr.annotation(fromStore))
    if (fromUser) {
      const breakpoints = studioOf(update.state).breakpoints
      if (breakpoints !== studioOf(update.startState).breakpoints) {
        options.actions.setBreakpoints(breakpoints)
      }
      options.onUserEdit(update.state.doc.toString())
    }
    if (update.selectionSet || update.docChanged) {
      const head = update.state.selection.main.head
      options.onCursorLine(update.state.doc.lineAt(head).number)
    }
  })
}

/**
 * Ctrl/⌘+Enter belongs to the studio's global shortcut (Run): swallow CodeMirror's
 * insertBlankLine without stopping propagation, so the window-level handler still sees it.
 */
const runKeyPassthrough = Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => true }]))

export function editorExtensions(options: SetupOptions): Extension {
  return [
    runKeyPassthrough,
    studioActions.of(options.actions),
    studioField,
    breakpointGutterExtension(),
    lineNumbers(),
    heatGutterExtension(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    hindsightLanguage(),
    penDecorations,
    valueHover,
    hindsightTheme,
    EditorView.contentAttributes.of({ 'aria-label': 'Program source' }),
    listeners(options),
  ]
}
