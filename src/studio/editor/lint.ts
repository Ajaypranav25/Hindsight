/** Compile diagnostics as lint squiggles. */
import { setDiagnostics, type Diagnostic as LintDiagnostic } from '@codemirror/lint'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { Diagnostic } from '../../core/index'

function renderMessage(diagnostic: Diagnostic): () => Node {
  return () => {
    const root = document.createElement('div')
    root.className = 'ed-lint-message'
    const message = document.createElement('p')
    message.className = 'ed-lint-text'
    message.textContent = diagnostic.message
    root.append(message)
    if (diagnostic.hint) {
      const hint = document.createElement('p')
      hint.className = 'ed-lint-hint'
      hint.textContent = diagnostic.hint
      root.append(hint)
    }
    return root
  }
}

/** Compile diagnostics as CodeMirror diagnostics, clamped to a document of `length`. */
export function toLintDiagnostics(
  diagnostics: readonly Diagnostic[],
  length: number,
): LintDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const from = Math.max(0, Math.min(diagnostic.span.start, length))
    const to = Math.max(from, Math.min(diagnostic.span.end, length))
    return {
      from,
      to,
      severity: diagnostic.severity === 'error' ? 'error' : 'warning',
      source: diagnostic.code,
      message: diagnostic.hint ? `${diagnostic.message} (${diagnostic.hint})` : diagnostic.message,
      renderMessage: renderMessage(diagnostic),
    }
  })
}

/**
 * A transaction showing `diagnostics`, or none when the store's source differs from the document
 * (the diagnostics belong to other text).
 */
export function diagnosticsTransaction(
  state: EditorState,
  diagnostics: readonly Diagnostic[],
  storeSource: string,
): TransactionSpec {
  const matches = state.doc.length === storeSource.length && state.doc.toString() === storeSource
  return setDiagnostics(state, matches ? toLintDiagnostics(diagnostics, state.doc.length) : [])
}
