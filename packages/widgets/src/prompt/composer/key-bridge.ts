/**
 * The seam between the widget extension's keyboard shortcuts and React —
 * the same shape as mention-bridge.ts, for the same reason: the extension's
 * `addKeyboardShortcuts` is built when the document's editor is constructed,
 * outside React, but the composer's actions (send, revert, dismiss, escape)
 * live in the mounted PromptBlob, which knows the store, the host and the
 * widget's phase.
 *
 * Why the shortcuts are an extension keymap and not a DOM listener on the
 * widget's own element: key events in a contenteditable target the editing
 * host — the document's `.ProseMirror` root — not the element under the
 * caret. The root is an ANCESTOR of the widget, so a bubbling listener on
 * the card never sees a single keystroke. ProseMirror's keymap plugins are
 * the one delivery path that actually runs for a caret inside the draft.
 *
 * Keyed by blobId: the extension resolves which draft holds the selection
 * (doc-helpers' selectionDraft) and forwards to exactly that widget.
 */

/** What the extension forwards. `shiftKey` matters only to Enter. */
export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
}

/** @returns true when the key was consumed (the extension stops it). */
export type ComposerKeyHandler = (input: ComposerKeyInput) => boolean;

const handlers = new Map<string, ComposerKeyHandler>();

/** @returns the unregistration, for the widget's effect cleanup. */
export function registerComposerKeyHandler(
  blobId: string,
  handler: ComposerKeyHandler,
): () => void {
  handlers.set(blobId, handler);
  return () => {
    if (handlers.get(blobId) === handler) handlers.delete(blobId);
  };
}

/** Forward one key to the widget owning the selection's draft. */
export function dispatchComposerKey(
  blobId: string,
  input: ComposerKeyInput,
): boolean {
  return handlers.get(blobId)?.(input) ?? false;
}
