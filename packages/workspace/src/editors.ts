/**
 * EditorHandle — identity + actions over a mounted editor instance, plus the
 * reverse links back into the graph (`.file()`, `.tab()`). No cached state:
 * every call resolves the live instance through the registered provider, so
 * a handle obtained once stays correct across mount/dispose cycles.
 *
 * Desktop owns the actual Tiptap instance (`editor-store.ts`); this module
 * only knows the small `EditorSnapshot` shape below, registered once via
 * `registerEditorProvider`.
 */
import { createProvider } from "./provider";
import { file, type FileHandle } from "./files";
import { tab, type TabHandle } from "./tabs";

export interface EditorSnapshot {
  focus(): boolean;
  isFocusable(): boolean;
  isMarkdown(): boolean;
  /** Serialized markdown text, if this is a mounted markdown instance. */
  markdownText(): string | undefined;
}

export type EditorProvider = (filePath: string) => EditorSnapshot | undefined;

const editorProvider = createProvider<[string], EditorSnapshot | undefined>(() => undefined);

export const registerEditorProvider: (next: EditorProvider) => void = editorProvider.register;

export interface EditorHandle {
  readonly workspacePath: string;
  readonly filePath: string;
  isMounted(): boolean;
  focus(): boolean;
  markdownText(): string | undefined;
  file(): FileHandle;
  tab(): TabHandle;
}

export function editor(workspacePath: string, filePath: string): EditorHandle {
  return {
    workspacePath,
    filePath,
    isMounted() {
      return editorProvider.resolve(filePath) !== undefined;
    },
    focus() {
      return editorProvider.resolve(filePath)?.focus() ?? false;
    },
    markdownText() {
      return editorProvider.resolve(filePath)?.markdownText();
    },
    file() {
      return file(workspacePath, filePath);
    },
    tab() {
      // File tab ids are the file path, by convention (tab-id.ts).
      return tab(workspacePath, filePath);
    },
  };
}
