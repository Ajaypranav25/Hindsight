/**
 * The Hindsight commands. Each takes the document from its first argument when VS Code passes one
 * (a code lens, the editor title or context menu), else the active editor; a code lens passes the
 * line as the second argument, else the cursor line is used.
 */
import * as path from 'node:path'
import * as vscode from 'vscode'
import { crashSlice, momentFor, runReport, whyNotSentence } from '../analysis'
import { studioLink } from '../studio-link'
import { COMMANDS, LANGUAGE_ID, problemReport, targetLine } from '../view'
import type { Highlights } from './presenters'
import type { Runs } from './runs'

export interface CommandContext {
  readonly runs: Runs
  readonly highlights: Highlights
  readonly output: vscode.OutputChannel
}

const fileName = (document: vscode.TextDocument) => path.basename(document.fileName)

/** The editor a command applies to, or null (with a message) when there is no .sight editor. */
async function editorFor(argument: unknown): Promise<vscode.TextEditor | null> {
  let editor = vscode.window.activeTextEditor
  if (argument instanceof vscode.Uri) {
    const shown = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === argument.toString(),
    )
    editor = shown ?? (await vscode.window.showTextDocument(argument, { preserveFocus: true }))
  }
  if (editor === undefined || editor.document.languageId !== LANGUAGE_ID) {
    void vscode.window.showWarningMessage('Hindsight: open a .sight file first.')
    return null
  }
  return editor
}

/** The run of the editor's current text, or null (with a message) when it does not compile. */
async function recordingOf(context: CommandContext, editor: vscode.TextEditor) {
  const result = await context.runs.fresh(editor.document)
  if (result === null) return null
  if (result.analysis.kind === 'compile-error') {
    const [first] = result.analysis.problems
    // The first line of the message: a hint follows on the next one.
    const message = first?.message.split('\n')[0]
    const where = first === undefined ? '' : ` (line ${first.start.line}: ${message})`
    void vscode.window.showWarningMessage(
      `Hindsight: ${fileName(editor.document)} does not compile${where}.`,
    )
    return null
  }
  return result.analysis
}

const cursorLine = (editor: vscode.TextEditor) => editor.selection.active.line + 1

async function runFile(context: CommandContext, argument: unknown): Promise<void> {
  const editor = await editorFor(argument)
  if (editor === null) return
  const result = await context.runs.runNow(editor.document)
  if (result === null) return
  const name = fileName(editor.document)
  const lines =
    result.analysis.kind === 'compile-error'
      ? problemReport(result.analysis.problems, name)
      : runReport(result.analysis.recording, name)
  context.output.appendLine(`--- ${name} ---`)
  for (const line of lines) context.output.appendLine(line)
  context.output.show(true)
}

async function whyNot(context: CommandContext, argument: unknown, line: unknown): Promise<void> {
  const editor = await editorFor(argument)
  if (editor === null) return
  const target = targetLine(line, cursorLine(editor), editor.document.lineCount)
  const analysis = await recordingOf(context, editor)
  if (analysis === null) return
  context.highlights.explain(editor, target, whyNotSentence(analysis.recording, target))
}

async function showCrashSlice(context: CommandContext, argument: unknown): Promise<void> {
  const editor = await editorFor(argument)
  if (editor === null) return
  const analysis = await recordingOf(context, editor)
  if (analysis === null) return
  const slice = crashSlice(analysis.recording)
  if (slice.kind !== 'sliced') {
    void vscode.window.showInformationMessage(`Hindsight: ${slice.message}`)
    return
  }
  context.highlights.dim(editor, slice.dim)
  const choice = await vscode.window.showInformationMessage(
    `Hindsight: ${slice.message}`,
    'Clear Highlights',
  )
  if (choice !== undefined) context.highlights.clear(editor)
}

async function openInStudio(context: CommandContext, argument: unknown): Promise<void> {
  const editor = await editorFor(argument)
  if (editor === null) return
  const source = editor.document.getText()
  const result = await context.runs.fresh(editor.document)
  const step =
    result?.analysis.kind === 'recorded'
      ? momentFor(result.analysis.recording, cursorLine(editor))
      : null
  const settings = vscode.workspace.getConfiguration('hindsight', editor.document.uri)
  const link = studioLink(source, step, settings.get<string>('studioUrl'))
  if (!link.ok) {
    void vscode.window.showErrorMessage(`Hindsight: ${link.error}`)
    return
  }
  // A Uri would percent-encode the fragment's `=` and `&`, which the studio reads literally;
  // openExternal also accepts the URL as a string and passes it through unchanged.
  await vscode.env.openExternal(link.url as unknown as vscode.Uri)
}

async function clearHighlights(context: CommandContext, argument: unknown): Promise<void> {
  const editor = await editorFor(argument)
  if (editor !== null) context.highlights.clear(editor)
}

/** Reports a command that failed unexpectedly instead of letting VS Code show a raw stack. */
function guarded(
  context: CommandContext,
  name: string,
  handler: (...args: unknown[]) => Promise<void>,
) {
  return async (...args: unknown[]) => {
    try {
      await handler(...args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      context.output.appendLine(`${name} failed: ${error instanceof Error ? error.stack : message}`)
      void vscode.window.showErrorMessage(`Hindsight: ${name} failed: ${message}`)
    }
  }
}

export function registerCommands(context: CommandContext): vscode.Disposable[] {
  const commands: [string, string, (...args: unknown[]) => Promise<void>][] = [
    [COMMANDS.runFile, 'Run File', (uri) => runFile(context, uri)],
    [COMMANDS.whyNot, 'Why Not', (uri, line) => whyNot(context, uri, line)],
    [COMMANDS.crashSlice, 'Crash Slice', (uri) => showCrashSlice(context, uri)],
    [COMMANDS.openInStudio, 'Open in Studio', (uri) => openInStudio(context, uri)],
    [COMMANDS.clearHighlights, 'Clear Highlights', (uri) => clearHighlights(context, uri)],
  ]
  return commands.map(([id, name, handler]) =>
    vscode.commands.registerCommand(id, guarded(context, name, handler)),
  )
}
