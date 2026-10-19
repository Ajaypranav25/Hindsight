/** The editor theme, built from the studio's CSS tokens (both color schemes follow them). */
import { EditorView } from '@codemirror/view'

const SELECTION = {
  backgroundColor: 'var(--marker-soft)',
}

export const hindsightTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--ink)',
    backgroundColor: 'var(--surface)',
    fontSize: '13.5px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.65',
    fontVariantLigatures: 'none',
  },
  '.cm-content': {
    caretColor: 'var(--ink)',
    padding: 'var(--space-2) 0',
  },
  '.cm-line': {
    padding: '0 var(--space-4) 0 var(--space-2)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--ink)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': SELECTION,
  '.cm-selectionLayer .cm-selectionBackground': SELECTION,
  '.cm-content ::selection': SELECTION,
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--ink-faint)',
    borderRight: '1px solid var(--rule)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    fontVariantNumeric: 'tabular-nums',
    padding: '0 var(--space-2) 0 var(--space-1)',
    minWidth: '2.5ch',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--ink) 3%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--ink)',
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--marker-soft)',
    outline: '1px solid color-mix(in srgb, var(--marker) 45%, transparent)',
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'var(--error-soft)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--warn) 22%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--warn) 40%, transparent)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--marker) 10%, transparent)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-raised)',
    color: 'var(--ink)',
    border: '1px solid var(--rule)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: 'var(--shadow-pop)',
    fontFamily: 'var(--font-ui)',
  },
  '.cm-tooltip-lint': {
    padding: 0,
  },
  '.cm-diagnostic': {
    padding: 'var(--space-2) var(--space-3)',
    borderLeft: '3px solid var(--error)',
  },
  '.cm-diagnostic-error': {
    borderLeftColor: 'var(--error)',
  },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--error)',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
  },
  '.cm-panels': {
    backgroundColor: 'var(--surface-raised)',
    color: 'var(--ink)',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid var(--rule)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--rule)',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
    border: '1px solid var(--rule)',
    borderRadius: 'var(--radius-sm)',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
    border: '1px solid var(--rule)',
    borderRadius: 'var(--radius-sm)',
  },
})
