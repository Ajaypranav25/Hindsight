/**
 * A `.sighttrace` file dropped on the editor opens as a trace (ARCHITECTURE §11.3) instead of being
 * inserted as text. The handlers run in the capture phase, before CodeMirror's own drop handling.
 */
import type { DragEvent } from 'react'
import { isTraceFileName } from '../lib/trace-download'

/** The first trace file among the dropped files, or null. */
export function droppedTraceFile(transfer: Pick<DataTransfer, 'files'> | null): File | null {
  if (!transfer) return null
  return Array.from(transfer.files).find((file) => isTraceFileName(file.name)) ?? null
}

export interface TraceDropHandlers {
  onDragOverCapture(event: DragEvent<HTMLElement>): void
  onDropCapture(event: DragEvent<HTMLElement>): void
}

/** Handlers for the editor's root element; `open` receives the trace file's bytes. */
export function traceDropHandlers(open: (bytes: Uint8Array) => Promise<void>): TraceDropHandlers {
  return {
    onDragOverCapture(event) {
      // A file drag must be accepted here, or the browser opens the dropped file itself.
      if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault()
    },
    onDropCapture(event) {
      const file = droppedTraceFile(event.dataTransfer)
      if (file === null) return
      event.preventDefault()
      event.stopPropagation()
      void file.arrayBuffer().then((buffer) => open(new Uint8Array(buffer)))
    },
  }
}
