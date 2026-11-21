/**
 * Clipboard writes (ARCHITECTURE §11.6): called inside the click handler that asked for them, and
 * answering false when the clipboard refuses or is missing, so the caller can select the text for
 * a manual copy instead.
 */

interface ClipboardLike {
  writeText?(text: string): Promise<void>
}

/** Writes `text` to the clipboard; resolves to whether it worked. */
export function copyText(text: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: { clipboard?: ClipboardLike } }).navigator
    ?.clipboard
  if (clipboard?.writeText === undefined) return Promise.resolve(false)
  try {
    return clipboard.writeText(text).then(
      () => true,
      () => false,
    )
  } catch {
    return Promise.resolve(false)
  }
}

/** Selects the text of `node`, so Ctrl+C or ⌘ C copies it. */
export function selectText(node: Node): void {
  const selection = globalThis.getSelection?.()
  if (selection === null || selection === undefined) return
  selection.selectAllChildren(node)
}
