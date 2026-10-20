import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useRef } from 'react'
import { useStateView, useStudio, useStudioActions } from '../state/context'
import { isStale } from '../state/selectors'
import { setEditorCursorLine } from './cursor-line'
import { scrollStatementIntoView } from './decorations'
import { minimalChange } from './doc-sync'
import { maxHitCount } from './gutter-math'
import { LibraryChip } from './LibraryChip'
import { diagnosticsTransaction } from './lint'
import { computeOverlay, EMPTY_OVERLAY, originSpanAt, type EditorOverlay } from './overlay'
import { editorExtensions, fromStore } from './setup'
import { studioEffects, type EditorStudio } from './studio-field'
import './editor.css'

/** After a user edit, the editor does not scroll to follow the pen for this long. */
const TYPING_GRACE_MS = 1500
const NO_DIAGNOSTICS: never[] = []
const NO_HITS: ReadonlyMap<number, number> = new Map()

/** The code editor: the store's source, with the program's state at the pen drawn over it. */
export function Editor() {
  const source = useStudio((s) => s.source)
  const recording = useStudio((s) => s.recording)
  const stale = useStudio(isStale)
  const time = useStudio((s) => s.time)
  const selectedFrameUid = useStudio((s) => s.selectedFrameUid)
  const breakpoints = useStudio((s) => s.breakpoints)
  const compileResult = useStudio((s) => s.compile)
  const originMark = useStudio((s) => s.originMark)
  const view = useStateView()
  const actions = useStudioActions()

  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorView | null>(null)
  const overlayRef = useRef<EditorOverlay>(EMPTY_OVERLAY)
  const lastUserEditRef = useRef(0)
  const initialSourceRef = useRef(source)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const editor = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialSourceRef.current,
        extensions: editorExtensions({
          actions,
          onUserEdit: (text) => {
            lastUserEditRef.current = Date.now()
            actions.setSource(text)
          },
          onCursorLine: setEditorCursorLine,
        }),
      }),
    })
    editorRef.current = editor
    setEditorCursorLine(1)
    return () => {
      editor.destroy()
      editorRef.current = null
      setEditorCursorLine(null)
    }
  }, [actions])

  const diagnostics =
    compileResult && !compileResult.ok ? compileResult.diagnostics : NO_DIAGNOSTICS
  const hitCounts = useMemo(() => recording?.lineHitCounts() ?? NO_HITS, [recording])
  const maxHits = useMemo(() => maxHitCount(hitCounts), [hitCounts])
  const overlay = useMemo(() => {
    const base = computeOverlay({ view, stale, selectedFrameUid, source })
    const originSpan = stale ? null : originSpanAt(recording, originMark, time, source.length)
    return originSpan ? { ...base, originSpan } : base
  }, [view, stale, selectedFrameUid, source, recording, originMark, time])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const change = minimalChange(editor.state.doc.toString(), source)
    if (change) editor.dispatch({ changes: change, annotations: fromStore.of(true) })
    overlayRef.current = overlay
    const studio: EditorStudio = {
      view,
      stale,
      selectedFrameUid,
      recording,
      time,
      breakpoints,
      hitCounts,
      maxHits,
      overlay,
    }
    editor.dispatch(diagnosticsTransaction(editor.state, diagnostics, source), {
      effects: studioEffects(editor.state, studio),
    })
  }, [
    source,
    view,
    stale,
    selectedFrameUid,
    recording,
    time,
    breakpoints,
    hitCounts,
    maxHits,
    overlay,
    diagnostics,
  ])

  useEffect(() => {
    const editor = editorRef.current
    const span = overlayRef.current.stmtSpan ?? overlayRef.current.callerSpan
    if (!editor || !span) return
    if (Date.now() - lastUserEditRef.current < TYPING_GRACE_MS) return
    scrollStatementIntoView(editor, span.start)
  }, [time, recording, selectedFrameUid])

  return (
    <div className="ed-root">
      <div className="ed-host" ref={hostRef} />
      {overlay.libraryFunction !== null && <LibraryChip name={overlay.libraryFunction} />}
    </div>
  )
}
