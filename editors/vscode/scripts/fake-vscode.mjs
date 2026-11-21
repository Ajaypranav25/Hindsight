// A small stand-in for the `vscode` module: enough of the API for scripts/smoke.mjs to load the
// bundled extension in plain Node, drive it like an editor would and observe what it draws.

export class Position {
  constructor(line, character) {
    this.line = line
    this.character = character
  }
}

export class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) {
      this.start = a
      this.end = b
    } else {
      this.start = new Position(a, b)
      this.end = new Position(c, d)
    }
  }
}

export class Uri {
  constructor(path) {
    this.path = path
  }
  static file(path) {
    return new Uri(path)
  }
  toString() {
    return `file://${this.path}`
  }
}

export class EventEmitter {
  listeners = new Set()
  event = (listener) => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }
  fire(value) {
    for (const listener of this.listeners) listener(value)
  }
  dispose() {
    this.listeners.clear()
  }
}

export class Diagnostic {
  constructor(range, message, severity) {
    Object.assign(this, { range, message, severity })
  }
}

export class CodeLens {
  constructor(range, command) {
    Object.assign(this, { range, command })
  }
}

export class ThemeColor {
  constructor(id) {
    this.id = id
  }
}

export class MarkdownString {
  value = ''
  appendText(text) {
    this.value += text
    return this
  }
}

export const DiagnosticSeverity = { Error: 0, Warning: 1 }
export const DecorationRangeBehavior = { ClosedClosed: 1 }

/** What the extension did, for the smoke test to check. */
export const observed = {
  commands: new Map(),
  lensProviders: [],
  diagnostics: new Map(),
  messages: [],
  opened: [],
  output: [],
  handlers: new Map(),
  settings: new Map(),
  decorationTypes: [],
}

const on = (name) => (handler) => {
  const list = observed.handlers.get(name) ?? []
  observed.handlers.set(name, [...list, handler])
  return { dispose() {} }
}

let decorationTypes = 0
/** Every FakeDocument by URI, for showTextDocument. */
const documents = new Map()

export const window = {
  activeTextEditor: undefined,
  visibleTextEditors: [],
  createOutputChannel: () => ({
    appendLine: (line) => observed.output.push(line),
    show() {},
    dispose() {},
  }),
  createTextEditorDecorationType: (options) => {
    const type = { key: `type${++decorationTypes}`, options, dispose() {} }
    observed.decorationTypes.push(type)
    return type
  },
  showWarningMessage: async (text) => (observed.messages.push(['warning', text]), undefined),
  showInformationMessage: async (text) => (observed.messages.push(['info', text]), undefined),
  showErrorMessage: async (text) => (observed.messages.push(['error', text]), undefined),
  /** Opens the document with that URI in a new editor, which becomes the active one. */
  showTextDocument: async (uri) => {
    const document = documents.get(uri.toString())
    if (document === undefined) throw new Error(`no document ${uri}`)
    window.activeTextEditor = new FakeEditor(document)
    window.visibleTextEditors = [...window.visibleTextEditors, window.activeTextEditor]
    return window.activeTextEditor
  },
}

export const languages = {
  createDiagnosticCollection: () => ({
    set: (uri, list) => observed.diagnostics.set(uri.toString(), list),
    delete: (uri) => observed.diagnostics.delete(uri.toString()),
    dispose() {},
  }),
  registerCodeLensProvider: (_selector, provider) => {
    observed.lensProviders.push(provider)
    return { dispose() {} }
  },
}

export const workspace = {
  textDocuments: [],
  getConfiguration: () => ({
    get: (name, fallback) => (observed.settings.has(name) ? observed.settings.get(name) : fallback),
  }),
  asRelativePath: (uri) => uri.path,
  onDidOpenTextDocument: on('open'),
  onDidSaveTextDocument: on('save'),
  onDidCloseTextDocument: on('close'),
  onDidChangeTextDocument: on('change'),
  onDidChangeConfiguration: on('configuration'),
}

export const commands = {
  registerCommand: (id, handler) => {
    observed.commands.set(id, handler)
    return { dispose() {} }
  },
}

export const env = {
  openExternal: async (target) => (observed.opened.push(target), true),
}

/** A text document whose text the test can change (each change is a new version). */
export class FakeDocument {
  constructor(path, text, languageId = 'sight') {
    this.uri = Uri.file(path)
    this.fileName = path
    this.languageId = languageId
    this.version = 1
    this.text = text
    this.isClosed = false
    documents.set(this.uri.toString(), this)
  }
  getText() {
    return this.text
  }
  get lineCount() {
    return this.text.split('\n').length
  }
  lineAt(index) {
    const length = this.text.split('\n')[index].length
    return { range: new Range(index, 0, index, length) }
  }
  edit(text) {
    this.text = text
    this.version += 1
  }
}

/** An editor that remembers the decorations set on it, by decoration type. */
export class FakeEditor {
  decorations = new Map()
  constructor(document, cursorLine = 0) {
    this.document = document
    this.selection = { active: new Position(cursorLine, 0) }
  }
  setDecorations(type, ranges) {
    this.decorations.set(type.key, ranges)
  }
}
