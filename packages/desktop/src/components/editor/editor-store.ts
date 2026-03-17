/**
 * Editor Instance Store
 *
 * Maintains a module-level Map of PlateEditor instances keyed by file path.
 * This allows editor instances (with their undo history, internal state, etc.)
 * to survive across component mount/unmount cycles — e.g. when Dockable
 * unmounts a tab that isn't currently selected and remounts it later.
 *
 * Editors are created via `createPlateEditor` (a plain function, not a hook),
 * so they have no React lifecycle tied to them.
 */

import { createPlateEditor, type PlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { MarkdownEditorKit } from "@/components/editor/markdown-editor-kit";
import { Editor as SlateEditor } from "slate";
import type { BaseSelection } from "slate";

/** Module-level store: file path → editor instance */
const editorInstances = new Map<string, PlateEditor>();

/** Saved selections: file path → last known selection (survives unmount) */
const savedSelections = new Map<string, BaseSelection>();

/**
 * Get an existing editor for a file path, or create one with the given
 * initial markdown content.
 *
 * If an editor already exists for the path, the `content` argument is
 * ignored — the existing instance (with its undo history, etc.) is returned.
 */
export function getOrCreateEditor(
  filePath: string,
  content: string,
): PlateEditor {
  const existing = editorInstances.get(filePath);
  if (existing) return existing;

  const editor = createPlateEditor({
    plugins: MarkdownEditorKit,
    value: (e) =>
      (e as PlateEditor).getApi(MarkdownPlugin).markdown.deserialize(content),
  });

  // Enable chunking for large documents (Slate performance optimization).
  // Splits the document into chunks of 1000 nodes to reduce React
  // re-rendering overhead for files with thousands of lines.
  (editor as any).getChunkSize = (node: any) => {
    return SlateEditor.isEditor(node) ? 1000 : null;
  };

  editorInstances.set(filePath, editor);
  return editor;
}

/**
 * Dispose an editor instance when a tab is permanently closed.
 * This frees the memory held by the Slate document tree and undo history.
 */
export function disposeEditor(filePath: string): void {
  editorInstances.delete(filePath);
  savedSelections.delete(filePath);
}

/**
 * Dispose all editors (e.g. when switching workspaces).
 */
export function disposeAllEditors(): void {
  editorInstances.clear();
  savedSelections.clear();
}

/**
 * Check if an editor instance exists for a given file path.
 */
export function hasEditor(filePath: string): boolean {
  return editorInstances.has(filePath);
}

export function getEditor(filePath: string): PlateEditor | undefined {
  return editorInstances.get(filePath);
}

/**
 * Imperatively focus an editor for the given file path.
 * Restores the last saved selection if available; otherwise focuses at the start.
 * Returns true if the editor existed and focus was attempted.
 */
export function focusEditor(filePath: string): boolean {
  const editor = editorInstances.get(filePath);
  if (!editor) return false;

  const saved = savedSelections.get(filePath) ?? editor.selection ?? null;
  if (saved) {
    editor.tf.focus({ at: saved });
  } else {
    editor.tf.focus();
  }

  return true;
}

/**
 * Save the current selection for an editor so it can be restored after remount.
 */
export function saveSelection(
  filePath: string,
  selection: BaseSelection,
): void {
  savedSelections.set(filePath, selection);
}

/**
 * Retrieve a previously saved selection (returns undefined if none saved).
 */
export function getSavedSelection(filePath: string): BaseSelection | undefined {
  return savedSelections.get(filePath);
}
