/**
 * The entry point VS Code loads (bundled to dist/extension.js): records .sight files when they are
 * opened and saved, publishes their problems, shows the code lenses and registers the commands.
 */
import * as vscode from 'vscode'
import { LANGUAGE_ID } from '../view'
import { registerCommands } from './commands'
import { Highlights, LensProvider } from './presenters'
import { Runs } from './runs'

const isSight = (document: vscode.TextDocument) => document.languageId === LANGUAGE_ID

function setting<T>(document: vscode.TextDocument, name: string, fallback: T): T {
  return vscode.workspace.getConfiguration('hindsight', document.uri).get<T>(name, fallback)
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Hindsight')
  const diagnostics = vscode.languages.createDiagnosticCollection('hindsight')
  const runs = new Runs(diagnostics, (line) => output.appendLine(line))
  const highlights = new Highlights()
  const lenses = new LensProvider(runs, (document) => setting(document, 'codeLens', true))

  const runIfWanted = (document: vscode.TextDocument) => {
    if (isSight(document) && setting(document, 'runOnSave', true)) runs.schedule(document)
  }

  context.subscriptions.push(
    output,
    diagnostics,
    runs,
    highlights,
    lenses,
    vscode.languages.registerCodeLensProvider({ language: LANGUAGE_ID }, lenses),
    ...registerCommands({ runs, highlights, output }),
    vscode.workspace.onDidOpenTextDocument(runIfWanted),
    vscode.workspace.onDidSaveTextDocument(runIfWanted),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (isSight(document)) runs.forget(document)
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isSight(event.document) && event.contentChanges.length > 0)
        highlights.clearDocument(event.document)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('hindsight')) lenses.refresh()
    }),
  )

  // The documents that were open when the extension activated (activation is on opening one).
  for (const document of vscode.workspace.textDocuments) runIfWanted(document)
}

export function deactivate(): void {
  // Everything is disposed through the extension context's subscriptions.
}
