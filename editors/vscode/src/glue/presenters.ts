/**
 * What the extension draws: code lenses from the last run, the inline why-not explanation after a
 * line, and dimmed lines around a crash slice.
 */
import * as vscode from 'vscode'
import { inlineText, type LensSpec, lensSpecs } from '../view'
import type { Runs, RunResult } from './runs'

export class LensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly refreshed = new vscode.EventEmitter<void>()
  private readonly subscription: vscode.Disposable
  /** Lens specs per result: VS Code asks again on every edit and scroll into new code. */
  private readonly cache = new WeakMap<RunResult, LensSpec[]>()
  readonly onDidChangeCodeLenses = this.refreshed.event

  constructor(
    private readonly runs: Runs,
    private readonly enabled: (document: vscode.TextDocument) => boolean,
  ) {
    this.subscription = runs.onDidChange(() => this.refresh())
  }

  refresh(): void {
    this.refreshed.fire()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled(document)) return []
    const result = this.runs.current(document)
    if (result === null || result.analysis.kind !== 'recorded') return []
    let specs = this.cache.get(result)
    if (specs === undefined) {
      specs = lensSpecs(result.analysis.recording)
      this.cache.set(result, specs)
    }
    return specs.map((spec) => {
      const range = new vscode.Range(spec.line - 1, 0, spec.line - 1, 0)
      return new vscode.CodeLens(range, {
        title: spec.title,
        tooltip: spec.tooltip,
        // An empty command shows the title as text with nothing to click.
        command: spec.command ?? '',
        arguments: spec.command === null ? undefined : [document.uri, spec.line],
      })
    })
  }

  dispose(): void {
    this.subscription.dispose()
    this.refreshed.dispose()
  }
}

export class Highlights implements vscode.Disposable {
  private readonly explanation = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  private readonly dimmed = vscode.window.createTextEditorDecorationType({ opacity: '0.35' })

  /** Shows `sentence` after the end of `line` (1-based), replacing any earlier explanation. */
  explain(editor: vscode.TextEditor, line: number, sentence: string): void {
    const end = editor.document.lineAt(line - 1).range.end
    const hover = new vscode.MarkdownString()
    hover.appendText(sentence)
    editor.setDecorations(this.explanation, [
      {
        range: new vscode.Range(end, end),
        hoverMessage: hover,
        renderOptions: { after: { contentText: inlineText(sentence) } },
      },
    ])
  }

  /** Dims the given 1-based lines, replacing any earlier dimming. */
  dim(editor: vscode.TextEditor, lines: readonly number[]): void {
    const count = editor.document.lineCount
    const ranges = lines
      .filter((line) => line >= 1 && line <= count)
      .map((line) => editor.document.lineAt(line - 1).range)
    editor.setDecorations(this.dimmed, ranges)
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.explanation, [])
    editor.setDecorations(this.dimmed, [])
  }

  /** Clears every editor showing `document` (its text changed, so the highlights are stale). */
  clearDocument(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors)
      if (editor.document === document) this.clear(editor)
  }

  dispose(): void {
    this.explanation.dispose()
    this.dimmed.dispose()
  }
}
