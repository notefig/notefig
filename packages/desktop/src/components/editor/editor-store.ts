/**
 * Polymorphic Editor Instance Store
 *
 * Maintains a unified registry of all editor types (markdown, code, image viewers).
 * Each editor type implements a common interface with polymorphic methods.
 * Irrelevant operations are no-ops for each type.
 */

import { createPlateEditor, type PlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { MarkdownEditorKit } from "@/components/editor/markdown-editor-kit";
import { Editor as SlateEditor } from "slate";
import type { BaseSelection } from "slate";
import type { RefObject } from "react";

export type EditorType = "markdown" | "code" | "image";

/**
 * Base interface that all editor instances must implement
 */
export interface EditorInstance {
  readonly type: EditorType;
  /**
   * Focus this editor. Returns true if focus was attempted, false if not applicable.
   * For non-focusable editors (images), this is a no-op that returns false.
   */
  focus(): boolean;
  /**
   * Dispose of this editor instance. Cleans up any resources.
   */
  dispose(): void;
  /**
   * Returns true if this editor type supports focus operations.
   */
  isFocusable(): boolean;
}

/**
 * Markdown editor instance using Plate.js
 */
export interface MarkdownInstance extends EditorInstance {
  readonly type: "markdown";
  readonly editor: PlateEditor;
  selection: BaseSelection | null;
}

/**
 * Code editor instance using plain textarea
 * editorState is nested to allow easy migration to Plate-based code editor later
 */
export interface CodeInstance extends EditorInstance {
  readonly type: "code";
  editorState: {
    textareaRef: RefObject<HTMLTextAreaElement | null>;
    content: string;
  };
}

/**
 * Image viewer instance (stateless, read-only)
 */
export interface ImageInstance extends EditorInstance {
  readonly type: "image";
}

/** Module-level store: file path → editor instance */
const editorInstances = new Map<string, EditorInstance>();

function createMarkdownInstance(content: string): MarkdownInstance {
  const editor = createPlateEditor({
    plugins: MarkdownEditorKit,
    value: (e) =>
      (e as PlateEditor).getApi(MarkdownPlugin).markdown.deserialize(content),
  });

  // Enable chunking for large documents (Slate performance optimization).
  (editor as any).getChunkSize = (node: any) => {
    return SlateEditor.isEditor(node) ? 1000 : null;
  };

  const instance: MarkdownInstance = {
    type: "markdown",
    editor,
    selection: null,
    focus(): boolean {
      const saved = this.selection ?? this.editor.selection;
      if (saved) {
        this.editor.tf.focus({ at: saved });
      } else {
        this.editor.tf.focus();
      }
      return true;
    },
    dispose(): void {
      // Plate editors clean up automatically when GC'd
      this.selection = null;
    },
    isFocusable(): boolean {
      return true;
    },
  };

  return instance;
}

function createCodeInstance(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): CodeInstance {
  const instance: CodeInstance = {
    type: "code",
    editorState: {
      textareaRef,
      content: "",
    },
    focus(): boolean {
      this.editorState.textareaRef.current?.focus();
      return true;
    },
    dispose(): void {
      // Cleanup any textarea listeners if needed
      this.editorState.content = "";
    },
    isFocusable(): boolean {
      return true;
    },
  };

  return instance;
}

function createImageInstance(): ImageInstance {
  const instance: ImageInstance = {
    type: "image",
    focus(): boolean {
      // No-op: images are not focusable
      return false;
    },
    dispose(): void {
      // No-op: stateless viewer
    },
    isFocusable(): boolean {
      return false;
    },
  };

  return instance;
}

interface MarkdownConfig {
  type: "markdown";
  content: string;
}

interface CodeConfig {
  type: "code";
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

interface ImageConfig {
  type: "image";
}

type EditorConfig = MarkdownConfig | CodeConfig | ImageConfig;

/**
 * Get an existing editor for a file path, or create one with the given configuration.
 * This is the main singleton pattern entry point - editors are cached by file path
 * and survive across component mount/unmount cycles.
 *
 * If an editor already exists for the path:
 * - And the type matches, returns the existing instance
 * - And the type doesn't match, disposes the old and creates new
 *
 * @param filePath - The absolute file path (used as the cache key)
 * @param config - Editor configuration including type and type-specific options
 * @returns The editor instance (cast to appropriate type by caller)
 */
export function getOrCreateEditor(
  filePath: string,
  config: EditorConfig,
): EditorInstance {
  const existing = editorInstances.get(filePath);
  if (existing) {
    // If types match, return existing
    if (existing.type === config.type) {
      return existing;
    }
    // If types don't match, dispose old and create new
    existing.dispose();
  }

  let instance: EditorInstance;

  switch (config.type) {
    case "markdown":
      instance = createMarkdownInstance(config.content);
      break;
    case "code":
      instance = createCodeInstance(config.textareaRef);
      break;
    case "image":
      instance = createImageInstance();
      break;
    default:
      throw new Error(`Unknown editor type: ${(config as any).type}`);
  }

  editorInstances.set(filePath, instance);
  return instance;
}

/**
 * Type guard for markdown instances
 */
export function isMarkdownInstance(
  instance: EditorInstance | undefined,
): instance is MarkdownInstance {
  return instance?.type === "markdown";
}

/**
 * Type guard for code instances
 */
export function isCodeInstance(
  instance: EditorInstance | undefined,
): instance is CodeInstance {
  return instance?.type === "code";
}

/**
 * Type guard for image instances
 */
export function isImageInstance(
  instance: EditorInstance | undefined,
): instance is ImageInstance {
  return instance?.type === "image";
}

/**
 * Get an existing editor instance by file path.
 */
export function getEditor(filePath: string): EditorInstance | undefined {
  return editorInstances.get(filePath);
}

/**
 * Get the editor type for a file path.
 */
export function getEditorType(filePath: string): EditorType | undefined {
  return editorInstances.get(filePath)?.type;
}

/**
 * Check if an editor instance exists for a file path.
 */
export function hasEditor(filePath: string): boolean {
  return editorInstances.has(filePath);
}

/**
 * Check if an editor is focusable.
 */
export function isEditorFocusable(filePath: string): boolean {
  return editorInstances.get(filePath)?.isFocusable() ?? false;
}

/**
 * Dispose an editor instance when a tab is permanently closed.
 * This frees the memory held by the editor.
 */
export function disposeEditor(filePath: string): void {
  const instance = editorInstances.get(filePath);
  if (instance) {
    instance.dispose();
    editorInstances.delete(filePath);
  }
}

/**
 * Dispose all editors (e.g. when switching workspaces).
 */
export function disposeAllEditors(): void {
  editorInstances.forEach((instance) => instance.dispose());
  editorInstances.clear();
}

/**
 * Focus an editor by file path.
 * Returns true if focus was attempted/applicable, false otherwise.
 * For non-focusable editors (images), returns false without doing anything.
 */
export function focusEditor(filePath: string): boolean {
  const instance = editorInstances.get(filePath);
  if (!instance) return false;
  return instance.focus();
}

/**
 * Get a markdown editor instance (type-safe accessor).
 * Returns undefined if the editor doesn't exist or isn't a markdown editor.
 */
export function getMarkdownEditor(filePath: string): PlateEditor | undefined {
  const instance = editorInstances.get(filePath);
  if (isMarkdownInstance(instance)) {
    return instance.editor;
  }
  return undefined;
}

/**
 * Get code editor state (type-safe accessor).
 * Returns undefined if the editor doesn't exist or isn't a code editor.
 */
export function getCodeState(
  filePath: string,
): CodeInstance["editorState"] | undefined {
  const instance = editorInstances.get(filePath);
  if (isCodeInstance(instance)) {
    return instance.editorState;
  }
  return undefined;
}

/**
 * Save the current selection for a markdown editor.
 * No-op for other editor types.
 */
export function saveSelection(
  filePath: string,
  selection: BaseSelection,
): void {
  const instance = editorInstances.get(filePath);
  if (isMarkdownInstance(instance)) {
    instance.selection = selection;
  }
}

/**
 * Retrieve a previously saved selection for a markdown editor.
 * Returns undefined for other editor types or if none saved.
 */
export function getSavedSelection(filePath: string): BaseSelection | undefined {
  const instance = editorInstances.get(filePath);
  if (isMarkdownInstance(instance)) {
    return instance.selection ?? undefined;
  }
  return undefined;
}

/**
 * Get all registered editor paths.
 */
export function getAllEditorPaths(): string[] {
  return Array.from(editorInstances.keys());
}
