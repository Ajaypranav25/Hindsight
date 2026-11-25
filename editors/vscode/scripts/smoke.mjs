// Loads the bundled extension (dist/extension.js) in plain Node against scripts/fake-vscode.mjs and
// drives it like an editor: open, save, edit and close .sight documents, run every command, and
// check the problems, code lenses, decorations, output and studio links it produces.
//
//   npm run build && npm run smoke
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import * as vscode from './fake-vscode.mjs'

const { observed, FakeDocument, FakeEditor } = vscode

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain)
}
const require = createRequire(import.meta.url)
const extension = require('../dist/extension.js')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const PROGRAM = [
  'fn price(n) {', //            1
  '  if n > 100 {', //           2
  '    print("expensive")', //   3
  '  }', //                      4
  '  return n * 2', //           5
  '}', //                        6
  'let items = [10, 20]', //     7
  'for item in items {', //      8
  '  print(price(item))', //     9
  '}', //                        10
  'let i = 2', //                11
  'print(items[i])', //          12
].join('\n')

async function until(condition, what, ms = 15_000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const fire = (event, value) => observed.handlers.get(event).forEach((handler) => handler(value))
const run = (command, ...args) => observed.commands.get(command)(...args)
const provider = () => observed.lensProviders[0]
/** The ranges an editor shows for the decoration type with `option` (`after` or `opacity`). */
const decorationsOf = (editor, option) => {
  const type = observed.decorationTypes.find((t) => option in t.options)
  return editor.decorations.get(type.key) ?? []
}
const steps = []
const step = (name) => steps.push(name)

// Activation registers the declared commands and one lens provider.
const context = { subscriptions: [] }
extension.activate(context)
assert.deepEqual(
  [...observed.commands.keys()].sort(),
  manifest.contributes.commands.map((c) => c.command).sort(),
)
assert.equal(observed.lensProviders.length, 1)
step('activates and registers every declared command')

// Opening a document records it: the runtime error becomes a problem, lenses appear.
const shop = new FakeDocument('/work/shop.sight', PROGRAM)
const editor = new FakeEditor(shop, 8)
vscode.window.activeTextEditor = editor
vscode.window.visibleTextEditors = [editor]
fire('open', shop)
await until(() => observed.diagnostics.has(shop.uri.toString()), 'the first run')
const [problem] = observed.diagnostics.get(shop.uri.toString())
assert.match(problem.code, /^R\d{3}$/)
assert.equal(problem.range.start.line, 11)
assert.equal(problem.source, 'hindsight')
const lenses = provider().provideCodeLenses(shop)
assert.deepEqual(
  lenses.map((l) => [l.range.start.line, l.command.title, l.command.command]),
  [
    [0, 'ran 2 times', ''],
    [2, 'never ran — why not?', 'hindsight.whyNot'],
  ],
)
step('runs on open: problems and code lenses')

// The never-ran lens explains itself after the line.
await run(...[lenses[1].command.command, ...lenses[1].command.arguments])
const [explanation] = decorationsOf(editor, 'after')
assert.equal(explanation.range.start.line, 2)
assert.equal(explanation.range.start.character, '    print("expensive")'.length)
assert.match(explanation.renderOptions.after.contentText, /^Line 3 never ran because/)
step('why not: inline explanation after the line')

// The crash slice dims every line that did not lead to the error.
await run('hindsight.crashSlice')
const dimmed = decorationsOf(editor, 'opacity').map((range) => range.start.line + 1)
assert.ok(!dimmed.includes(7) && !dimmed.includes(11) && !dimmed.includes(12), `${dimmed}`)
assert.ok(dimmed.includes(3), `${dimmed}`)
assert.match(observed.messages.at(-1)[1], /lines? led to R\d{3}/)
step('crash slice: dims the unrelated lines')

// Open in Studio passes the desktop app's moment link as a string, fragment intact.
await run('hindsight.openInStudio')
const [url] = observed.opened
assert.equal(typeof url, 'string')
const match = /^hindsight:\/\/open\/#src=([A-Za-z0-9_-]+)&t=(\d+)$/.exec(url)
assert.ok(match, url)
assert.equal(Buffer.from(match[1], 'base64url').toString('utf8'), PROGRAM)
step('open in studio: a moment link with the cursor line')

// Run File prints the output and how the run ended.
await run('hindsight.runFile')
const report = observed.output.slice(observed.output.indexOf('--- shop.sight ---'))
assert.deepEqual(report.slice(0, 3), ['--- shop.sight ---', '20', '40'])
assert.match(report[3], /^\[shop\.sight:12\] runtime error R\d{3}: /)
step('run file: output channel report')

// Editing makes the run stale: highlights clear and lenses hide until the next run.
shop.edit(`${PROGRAM}\n`)
fire('change', { document: shop, contentChanges: [{}] })
assert.deepEqual(decorationsOf(editor, 'after'), [])
assert.deepEqual(decorationsOf(editor, 'opacity'), [])
assert.deepEqual(provider().provideCodeLenses(shop), [])
fire('save', shop)
fire('save', shop)
await until(() => provider().provideCodeLenses(shop).length === 2, 'the run after saving')
step('edit hides stale lenses; save runs again')

// A program that does not compile: a compile problem, and commands say so.
const broken = new FakeDocument('/work/broken.sight', 'let x = 1\nprint(x +)\n')
fire('open', broken)
await until(() => observed.diagnostics.has(broken.uri.toString()), 'the broken run')
assert.match(observed.diagnostics.get(broken.uri.toString())[0].code, /^E\d{3}$/)
await run('hindsight.whyNot', broken.uri, 1)
assert.equal(observed.messages.at(-1)[0], 'warning')
assert.match(
  observed.messages.at(-1)[1],
  /^Hindsight: broken\.sight does not compile \(line 2: [^\n]+\)\.$/,
)
assert.deepEqual(provider().provideCodeLenses(broken), [])
step('compile errors: problems and a warning, no lenses')

// The step budget setting applies.
observed.settings.set('maxSteps', 1_000)
const loop = new FakeDocument('/work/loop.sight', 'while true {\n}\n')
vscode.window.activeTextEditor = new FakeEditor(loop)
await run('hindsight.runFile')
assert.match(observed.output.at(-1), /step limit \(1,000 steps\)/)
step('the step budget setting')

// A newer run aborts the one in flight, which reports nothing.
observed.settings.set('maxSteps', 10_000_000)
const mark = observed.output.length
const slow = run('hindsight.runFile')
loop.edit('print("quick")\n')
const quick = run('hindsight.runFile')
await Promise.all([slow, quick])
assert.deepEqual(observed.output.slice(mark), [
  '--- loop.sight ---',
  'quick',
  observed.output.at(-1),
])
assert.match(observed.output.at(-1), /finished normally/)
step('a newer run aborts the stale one')

// Closing a document drops its problems; commands need a .sight editor.
fire('close', shop)
assert.equal(observed.diagnostics.has(shop.uri.toString()), false)
vscode.window.activeTextEditor = new FakeEditor(new FakeDocument('/work/a.txt', 'x', 'plaintext'))
await run('hindsight.runFile')
assert.deepEqual(observed.messages.at(-1), ['warning', 'Hindsight: open a .sight file first.'])
step('close forgets; commands need a .sight editor')

for (const disposable of context.subscriptions) disposable.dispose()
extension.deactivate()
for (const name of steps) console.log(`ok - ${name}`)
console.log(`smoke: ${steps.length} checks passed`)
