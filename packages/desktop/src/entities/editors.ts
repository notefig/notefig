/**
 * Editors entity — one-shot reads over the live Tiptap instances.
 *
 * Lifecycle and mutation stay on `components/editor/editor-store.ts`
 * (create/dispose, focus-priority arbitration, selection save/restore, raw
 * ProseMirror transactions): those own platform state, and routing them
 * through handles would break the never-own/never-cache rule. This module
 * only reads — through editor-store's public accessors, so the private
 * instance map stays private.
 */
import {
  getEditor,
  getMarkdownEditor,
  getSelectedText,
  isEditorFocusable,
} from "@/components/editor/editor-store";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { readLayout, extractTabIds, findLayoutSelectedTab } from "./tabs";
import { isLooseFile } from "./files";

const markdownCodec = createMarkdownCodec();

export interface EditorHandle {
  readonly filePath: string;
  /** Whether a live editor instance exists for this file. */
  isMounted(): boolean;
  /** Unsaved-changes state, from the document-sync layer. */
  isDirty(): boolean;
  isFocusable(): boolean;
  /** Serialized markdown of the live document; undefined for non-markdown editors. */
  markdownText(): string | undefined;
}

export function editor(filePath: string): EditorHandle {
  return {
    filePath,
    isMounted: () => getEditor(filePath) !== undefined,
    isDirty: () => getDocumentSync(filePath).isDirty(),
    isFocusable: () => isEditorFocusable(filePath),
    markdownText: () => {
      const markdownEditor = getMarkdownEditor(filePath);
      if (!markdownEditor) return undefined;
      return markdownCodec.serialize(markdownEditor.getJSON());
    },
  };
}

export interface WorkspaceEditorContext {
  openFiles: Array<{ path: string; dirty: boolean; active: boolean }>;
  activeFile: string | null;
  /** Coarse for Stage 1: whether the active file has a non-empty selection. */
  selection?: boolean;
}

/**
 * Read-only snapshot of what the user has open, scoped to one workspace.
 * Sourced from the URL (the layout's single source of truth) rather than a
 * React hook, so non-React callers (agent tools, the prompt composer) can
 * call it directly. Not reactive: callers that need live updates should
 * still go through `useLayoutSearchParam`/`useDockableTabs`.
 */
export function getWorkspaceEditorContext(
  workspacePath: string,
): WorkspaceEditorContext {
  const layout = readLayout();
  const activeFile = findLayoutSelectedTab(layout);

  // Workspace files plus registered loose files — both are user-opened
  // documents agents may see. Agent tabs (`agent:` ids) match neither.
  const belongsToWorkspace = (path: string) =>
    path.startsWith(workspacePath) || isLooseFile(workspacePath, path);

  const openFiles = extractTabIds(layout)
    .filter(belongsToWorkspace)
    .map((path) => ({
      path,
      dirty: editor(path).isDirty(),
      active: path === activeFile,
    }));

  return {
    openFiles,
    activeFile:
      activeFile && belongsToWorkspace(activeFile) ? activeFile : null,
    selection: activeFile
      ? getSelectedText(activeFile) !== undefined
      : undefined,
  };
}
