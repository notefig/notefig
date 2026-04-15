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
import { Editor as SlateEditor, Node, type Path } from "slate";
import { ReactEditor } from "slate-react";
import type { BaseSelection, Point, Range } from "slate";
import {
  fuzzyFind,
  columnToOffset,
  lineColumnToTextareaOffset,
} from "@/utils/navigation-utils";

/**
 * Location for editor navigation.
 * Mirrors SearchMatchLocation from search results.
 */
export interface EditorLocation {
  /** Line number (1-indexed) */
  line: number;
  /** Column number (1-indexed, optional - defaults to 1) */
  column?: number;
  /** Expected text at location for verification/fuzzy matching */
  expectedText?: string;
  /** Selection range end line (for multi-line selections) */
  endLine?: number;
  /** Selection range end column */
  endColumn?: number;
}

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
  /**
   * Navigate to a specific location in the editor.
   * Sets cursor/selection and scrolls the location into view.
   * @param location - Target location with line/column coordinates
   * @returns true if navigation succeeded, false if location is invalid or not applicable
   */
  goToLocation(location: EditorLocation): boolean;
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
  readonly filePath: string;
  editorState: {
    content: string;
  };
}

/**
 * Image viewer instance (stateless, read-only)
 */
export interface ImageInstance extends EditorInstance {
  readonly type: "image";
  readonly filePath: string;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    goToLocation(location: EditorLocation): boolean {
      try {
        // 1. Convert line number to Slate block path
        const blockPath = lineToBlockPath(this.editor, location.line);
        if (!blockPath) {
          console.warn(`Line ${location.line} not found in document`);
          return false;
        }

        // 2. Get the block at this path
        const block = Node.get(this.editor, blockPath);
        if (!block) return false;

        // 3. Convert column to text offset within the block
        const blockText = Node.string(block);
        const offset = columnToOffset(blockText.length, location.column ?? 1);

        // 4. Find the correct text node path and offset
        // Blocks may have multiple text nodes (with marks), so we need to walk the text
        const textPath = findTextNodePath(this.editor, blockPath, offset);
        if (!textPath) {
          console.warn(`Could not find text node at offset ${offset}`);
          return false;
        }

        // 5. Create start point
        let startPoint: Point = {
          path: textPath.path,
          offset: textPath.offset,
        };

        // 6. If expectedText provided, verify and adjust with fuzzy matching
        if (location.expectedText) {
          const blockText = Node.string(block);
          const computedOffset = textPath.absoluteOffset;

          // Check if the expected text exists at the computed position
          const textAtPosition = blockText.slice(
            computedOffset,
            computedOffset + location.expectedText.length,
          );

          if (textAtPosition !== location.expectedText) {
            // Fuzzy match: find closest occurrence of expected text
            const fuzzyOffset = fuzzyFind(
              blockText,
              location.expectedText,
              computedOffset,
            );
            if (fuzzyOffset !== -1) {
              const adjustedTextPath = findTextNodePath(
                this.editor,
                blockPath,
                fuzzyOffset,
              );
              if (adjustedTextPath) {
                startPoint = {
                  path: adjustedTextPath.path,
                  offset: adjustedTextPath.offset,
                };
              }
            }
          }
        }

        // 7. Create range (selection)
        let range: Range = { anchor: startPoint, focus: startPoint };

        // Handle selection range if end position provided
        if (
          location.endLine !== undefined &&
          location.endColumn !== undefined
        ) {
          const endBlockPath = lineToBlockPath(this.editor, location.endLine);
          if (endBlockPath) {
            const endBlock = Node.get(this.editor, endBlockPath);
            const endBlockText = Node.string(endBlock);
            const endOffset = columnToOffset(
              endBlockText.length,
              location.endColumn,
            );
            const endTextPath = findTextNodePath(
              this.editor,
              endBlockPath,
              endOffset,
            );
            if (endTextPath) {
              range.focus = {
                path: endTextPath.path,
                offset: endTextPath.offset,
              };
            }
          }
        }

        // 8. Set selection and focus using Plate's API
        this.editor.tf.select(range);

        // 9. Scroll into view
        try {
          const domRange = ReactEditor.toDOMRange(
            this.editor as unknown as ReactEditor,
            range,
          );
          const startContainer = domRange.startContainer;
          // Use numeric constant 3 for TEXT_NODE to avoid conflict with Slate's Node
          const scrollTarget =
            startContainer.nodeType === 3 // Node.TEXT_NODE
              ? startContainer.parentElement
              : (startContainer as Element);
          scrollTarget?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        } catch (scrollError) {
          // Scroll failed, but selection was set - still a partial success
          console.warn("Failed to scroll to location:", scrollError);
        }

        // 10. Focus the editor
        this.editor.tf.focus();

        return true;
      } catch (error) {
        console.error("Navigation failed:", error);
        return false;
      }
    },
  };

  return instance;
}

/**
 * Convert a 1-indexed line number to a Slate block path.
 * Treats each top-level block as a "line" in the document.
 */
function lineToBlockPath(editor: PlateEditor, line: number): Path | null {
  // Get all top-level block nodes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorAny = editor as any;
  const blocks = Array.from(
    SlateEditor.nodes(editorAny, {
      at: [],
      match: (n) => SlateEditor.isBlock(editorAny, n as any),
      mode: "highest", // Only top-level blocks
    }),
  );

  // Line is 1-indexed, array is 0-indexed
  if (line < 1 || line > blocks.length) {
    return null;
  }

  return blocks[line - 1][1];
}

/**
 * Find the text node path and relative offset for an absolute offset within a block.
 * Slate blocks can have multiple text nodes (e.g., with marks), so we need to
 * walk through them to find the correct path and offset.
 */
function findTextNodePath(
  editor: PlateEditor,
  blockPath: Path,
  absoluteOffset: number,
): { path: Path; offset: number; absoluteOffset: number } | null {
  const textNodes = Array.from(
    Node.texts(Node.get(editor, blockPath), { from: [] }),
  );

  if (textNodes.length === 0) {
    // Block has no text nodes - create a path to an empty text node
    return { path: [...blockPath, 0], offset: 0, absoluteOffset: 0 };
  }

  let accumulatedOffset = 0;

  for (const [textNode, relativePath] of textNodes) {
    const textLength = textNode.text.length;
    const startOffset = accumulatedOffset;
    const endOffset = startOffset + textLength;

    if (absoluteOffset <= endOffset) {
      // Found the text node containing our offset
      return {
        path: [...blockPath, ...relativePath],
        offset: absoluteOffset - startOffset,
        absoluteOffset: startOffset,
      };
    }

    accumulatedOffset = endOffset;
  }

  // Offset is past the end - return last position
  const lastText = textNodes[textNodes.length - 1];
  return {
    path: [...blockPath, ...lastText[1]],
    offset: lastText[0].text.length,
    absoluteOffset: accumulatedOffset - lastText[0].text.length,
  };
}

function createCodeInstance(filePath: string): CodeInstance {
  const instance: CodeInstance = {
    type: "code",
    filePath,
    editorState: {
      content: "",
    },
    focus(): boolean {
      // Look up the container by data attribute since we don't store a ref
      const el = document.querySelector(
        `[data-editor-container="${this.filePath}"]`,
      );
      if (el instanceof HTMLElement) {
        el.focus();
        return true;
      }
      return false;
    },
    dispose(): void {
      // Cleanup any textarea listeners if needed
      this.editorState.content = "";
    },
    isFocusable(): boolean {
      return true;
    },
    goToLocation(location: EditorLocation): boolean {
      try {
        const container = document.querySelector(
          `[data-editor-container="${this.filePath}"]`,
        );
        const textarea = container?.querySelector("textarea");

        if (!(textarea instanceof HTMLTextAreaElement)) {
          return false;
        }

        const content = textarea.value;

        const startOffset = lineColumnToTextareaOffset(
          content,
          location.line,
          location.column ?? 1,
        );

        let endOffset = startOffset;
        if (
          location.endLine !== undefined &&
          location.endColumn !== undefined
        ) {
          endOffset = lineColumnToTextareaOffset(
            content,
            location.endLine,
            location.endColumn,
          );
        } else if (location.expectedText) {
          endOffset = startOffset + location.expectedText.length;
        }

        textarea.setSelectionRange(startOffset, endOffset);

        textarea.focus();

        const lines = content.slice(0, startOffset).split("\n");
        const lineNumber = lines.length;
        const lineHeight =
          parseInt(getComputedStyle(textarea).lineHeight) || 20;
        const scrollTop = Math.max(0, (lineNumber - 5) * lineHeight); // 5 lines of padding above
        textarea.scrollTop = scrollTop;

        return true;
      } catch (error) {
        console.error("Code editor navigation failed:", error);
        return false;
      }
    },
  };

  return instance;
}

function createImageInstance(filePath: string): ImageInstance {
  const instance: ImageInstance = {
    type: "image",
    filePath,
    focus(): boolean {
      const selector = `[data-editor-container="${this.filePath}"]`;
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement) {
        el.focus();
        return true;
      }
      return false;
    },
    dispose(): void {
      // No-op: stateless viewer
    },
    isFocusable(): boolean {
      return true;
    },
    goToLocation(_location: EditorLocation): boolean {
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
      instance = createCodeInstance(filePath);
      break;
    case "image":
      instance = createImageInstance(filePath);
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

/**
 * Navigate to a specific location in an editor.
 * This is a convenience function that combines getting the editor and calling goToLocation.
 *
 * @param filePath - The file path of the editor
 * @param location - Target location with line/column coordinates
 * @returns true if navigation succeeded, false if editor doesn't exist or navigation failed
 */
export function navigateToLocation(
  filePath: string,
  location: EditorLocation,
): boolean {
  const instance = editorInstances.get(filePath);
  if (!instance) {
    console.warn(`No editor instance found for path: ${filePath}`);
    return false;
  }
  return instance.goToLocation(location);
}
