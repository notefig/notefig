/**
 * Editor Instance Store
 *
 * Maintains a unified registry of markdown editors and image viewers.
 * Each type implements a common interface with polymorphic methods.
 */

import { createPlateEditor, type PlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { MarkdownEditorKit } from "@/components/editor/markdown-editor-kit";
import {
  Editor as SlateEditor,
  Node,
  type Path,
  Range as SlateRange,
} from "slate";
import { ReactEditor } from "slate-react";
import type { BaseSelection, Point, Range } from "slate";
import {
  fuzzyFind,
  columnToOffset,
  markupPrefixLength,
  rawLineToBlockPath,
  type BlockNode,
} from "@/utils/navigation-utils";
import { focusArbiter } from "@/utils/focus-arbiter";
import { isSidebarTextEntryActive } from "@/utils/focus-arbiter";

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

import type { EditorType } from "./polymorphic-editor";

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
 * Image viewer instance (stateless, read-only)
 */
export interface ImageInstance extends EditorInstance {
  readonly type: "image";
  readonly filePath: string;
}

/** Module-level store: file path → editor instance */
const editorInstances = new Map<string, EditorInstance>();

const EDITOR_FOCUS_PRIORITY = 70;

let observedFocusIntentId: string | null = null;
let observedFocusResult = false;

function focusEditorPath(filePath: string): boolean {
  const instance = editorInstances.get(filePath);
  if (!instance) return false;

  return instance.focus();
}

focusArbiter.registerResolver("editor", (intent) => {
  if (intent.target.type !== "editor") return false;

  const result = focusEditorPath(intent.target.filePath);
  if (observedFocusIntentId === intent.id) {
    observedFocusResult = result;
  }
  return result;
});

/**
 * Suppress all editor focus for the given duration (ms).
 * Calling again resets the timer.
 */
export function suppressEditorFocus(durationMs = 300): void {
  focusArbiter.suppress("editor", durationMs);
}

function isEditorFocusSuppressed(): boolean {
  return isSidebarTextEntryActive(document.activeElement);
}

export function setActiveEditorFocusTarget(filePath: string | null): void {
  focusArbiter.setActiveEditor(filePath);
}

export function requestEditorFocus(
  filePath: string,
  options: {
    when?: "immediate" | "next-frame" | "when-mounted";
    reason?: string;
  } = {},
): string {
  return focusArbiter.request({
    domain: "editor",
    target: { type: "editor", filePath },
    priority: EDITOR_FOCUS_PRIORITY,
    reason: options.reason ?? "editor-focus",
    when: options.when ?? "immediate",
  });
}

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
      if (isEditorFocusSuppressed()) return false;

      const saved = this.editor.selection ?? this.selection;
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
        // 1. Map raw file line number to Slate AST path using heuristic line counting
        const mapping = rawLineToBlockPath(
          this.editor.children as BlockNode[],
          location.line,
        );

        if (!mapping) {
          console.warn(
            `Line ${location.line} could not be mapped to any block in document`,
          );
          return false;
        }

        // Skip non-navigable lines (code fences, table separators)
        if (mapping.isFenceLine || mapping.isSeparatorLine) {
          console.warn(
            `Line ${location.line} is a fence/separator line, not navigable`,
          );
          return false;
        }

        const blockPath = mapping.path;

        // 2. Get the node at the resolved path
        const block = Node.get(this.editor, blockPath);
        if (!block) return false;

        // 3. Convert column to text offset within the block,
        //    adjusting for markdown markup prefix characters (e.g. "## ", "- ", "> ")
        //    that are counted in the raw column but absent from Plate text.
        const topLevelBlock = this.editor.children[
          mapping.blockIndex
        ] as BlockNode;
        const prefixLen = markupPrefixLength(topLevelBlock);
        const adjustedColumn = Math.max(1, (location.column ?? 1) - prefixLen);
        const blockText = Node.string(block);
        const offset = columnToOffset(blockText.length, adjustedColumn);

        // 4. Find the correct text node path and offset
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
          const computedOffset = textPath.absoluteOffset;
          const textAtPosition = blockText.slice(
            computedOffset,
            computedOffset + location.expectedText.length,
          );

          if (textAtPosition !== location.expectedText) {
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
          const endMapping = rawLineToBlockPath(
            this.editor.children as BlockNode[],
            location.endLine,
          );
          if (
            endMapping &&
            !endMapping.isFenceLine &&
            !endMapping.isSeparatorLine
          ) {
            const endBlock = Node.get(this.editor, endMapping.path);
            const endBlockText = Node.string(endBlock);
            const endTopBlock = this.editor.children[
              endMapping.blockIndex
            ] as BlockNode;
            const endPrefixLen = markupPrefixLength(endTopBlock);
            const adjustedEndColumn = Math.max(
              1,
              location.endColumn - endPrefixLen,
            );
            const endOffset = columnToOffset(
              endBlockText.length,
              adjustedEndColumn,
            );
            const endTextPath = findTextNodePath(
              this.editor,
              endMapping.path,
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

        // 9. Save selection so focusEditor restores this location
        this.selection = range;

        // 10. Scroll into view
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

        // 11. Focus the editor
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

function createImageInstance(filePath: string): ImageInstance {
  const instance: ImageInstance = {
    type: "image",
    filePath,
    focus(): boolean {
      if (isEditorFocusSuppressed()) return false;

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

interface ImageConfig {
  type: "image";
}

type EditorConfig = MarkdownConfig | ImageConfig;

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

  const intentId = requestEditorFocus(filePath, {
    when: "immediate",
    reason: "focus-editor",
  });

  observedFocusIntentId = intentId;
  observedFocusResult = false;
  focusArbiter.flush();
  observedFocusIntentId = null;

  return observedFocusResult;
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
 * Get the currently selected text for a given editor, if any.
 */
export function getSelectedText(filePath: string): string | undefined {
  const instance = editorInstances.get(filePath);

  if (isMarkdownInstance(instance)) {
    const selection = instance.editor.selection ?? instance.selection;
    if (!selection || SlateRange.isCollapsed(selection)) {
      return undefined;
    }

    const text = SlateEditor.string(
      instance.editor as unknown as SlateEditor,
      selection,
    );
    return text.trim() ? text : undefined;
  }

  return undefined;
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
