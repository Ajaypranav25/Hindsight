/** Hindsight highlighting from the real lexer, plus language data and simple indentation. */
import { EditorState, type Extension, type Range } from '@codemirror/state'
import { indentService, indentUnit, getIndentUnit } from '@codemirror/language'
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'
import { highlightRanges, type SyntaxClass } from './highlight'

const MARKS = new Map<SyntaxClass, Decoration>()

function markFor(cls: SyntaxClass): Decoration {
  let mark = MARKS.get(cls)
  if (!mark) {
    mark = Decoration.mark({ class: `ed-syn-${cls}` })
    MARKS.set(cls, mark)
  }
  return mark
}

/** Builds syntax decorations for a whole document (programs are small; one lex per change). */
export function syntaxDecorations(source: string): DecorationSet {
  const ranges: Range<Decoration>[] = highlightRanges(source).map((r) =>
    markFor(r.cls).range(r.from, r.to),
  )
  return Decoration.set(ranges, true)
}

const syntaxPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = syntaxDecorations(view.state.doc.toString())
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = syntaxDecorations(update.state.doc.toString())
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

const OPENS_BLOCK = /[{([]\s*(\/\/.*)?$/
const CLOSES_BLOCK = /^\s*[})\]]/

/** Indentation: the previous non-blank line's, one unit deeper after an opening bracket. */
const indentation = indentService.of((context, pos) => {
  const line = context.lineAt(pos)
  let previous = line.from > 0 ? context.lineAt(line.from - 1) : null
  while (previous && previous.text.trim() === '' && previous.from > 0)
    previous = context.lineAt(previous.from - 1)
  if (!previous) return 0
  const unit = getIndentUnit(context.state)
  const base = /^\s*/.exec(previous.text)![0].replace(/\t/g, ' '.repeat(unit)).length
  const deeper = OPENS_BLOCK.test(previous.text) ? unit : 0
  const current = context.textAfterPos(pos)
  const shallower = CLOSES_BLOCK.test(current) ? unit : 0
  return Math.max(0, base + deeper - shallower)
})

const languageData = EditorState.languageData.of(() => [
  {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
    indentOnInput: /^\s*[})\]]$/,
  },
])

/** Everything that makes the editor speak Hindsight. */
export function hindsightLanguage(): Extension {
  return [syntaxPlugin, indentation, languageData, indentUnit.of('  ')]
}
