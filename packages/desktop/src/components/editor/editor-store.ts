/**
 * Editor Instance Store
 *
 * Maintains a unified registry of markdown editors and image viewers.
 * Each type implements a common interface with polymorphic methods.
 */

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { editorExtensions, MarkdownImage } from "@/components/editor/tiptap-editor-kit";
import { fuzzyFind } from "@/utils/navigation-utils";
import { focusArbiter } from "@/utils/focus-arbiter";
import { isSidebarTextEntryActive } from "@/utils/focus-arbiter";
import { platformAdapter } from "@/adapters";

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
 * Markdown editor instance using Tiptap
 */
export interface MarkdownInstance extends EditorInstance {
  readonly type: "markdown";
  readonly editor: Editor;
  filePath: string;
  savedSelection?: { from: number; to: number };
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

function createMarkdownInstance(filePath: string, content: string, basePath?: string): MarkdownInstance {
  const workspaceRoot = basePath || filePath.substring(0, filePath.lastIndexOf("/")) || "/";

  const extensions = [
    ...editorExtensions.filter((e) => e.name !== "image"),
    MarkdownImage.configure({ allowBase64: true, workspaceRoot } as any),
  ];

  const editor = new Editor({
    extensions,
    content,
    editable: true,
    autofocus: false,
    editorProps: {
      handleDrop(view, event, _slice, moved) {
        if (moved || !event.dataTransfer?.files.length) return false;

        const imageFiles: File[] = [];
        for (let i = 0; i < event.dataTransfer.files.length; i++) {
          if (event.dataTransfer.files[i].type.startsWith("image/")) {
            imageFiles.push(event.dataTransfer.files[i]);
          }
        }
        if (imageFiles.length === 0) return false;

        event.preventDefault();

        const pos = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        const insertPos = pos?.pos ?? view.state.selection.from;

        (async () => {
          for (const file of imageFiles) {
            try {
              const normalized = await dedupeAssetName(
                workspaceRoot,
                normalizeImageName(file.name),
              );
              const destPath = `${workspaceRoot}/assets/${normalized}`;
              const data = new Uint8Array(await file.arrayBuffer());

              await platformAdapter.writeBinaryFiles([
                { path: destPath, data },
              ]);

              view.dispatch(
                view.state.tr.insert(
                  insertPos,
                  view.state.schema.nodes.image.create({
                    src: `assets/${normalized}`,
                  }),
                ),
              );
            } catch (err) {
              console.error("[handleDrop] Failed:", err);
            }
          }
        })();

        return true;
      },

      handlePaste(view, event) {
        const items = event.clipboardData?.items;
        if (!items) return false;

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith("image/")) {
            event.preventDefault();
            const file = item.getAsFile();
            if (!file) continue;

            (async () => {
              try {
                const extension = item.type.split("/")[1] || "png";
                const name = await dedupeAssetName(
                  workspaceRoot,
                  `pasted-${Date.now()}.${extension}`,
                );
                const destPath = `${workspaceRoot}/assets/${name}`;
                const data = new Uint8Array(await file.arrayBuffer());

                await platformAdapter.writeBinaryFiles([
                  { path: destPath, data },
                ]);

                view.dispatch(
                  view.state.tr.insert(
                    view.state.selection.from,
                    view.state.schema.nodes.image.create({
                      src: `assets/${name}`,
                    }),
                  ),
                );
              } catch (err) {
                console.error("[handlePaste] Failed:", err);
              }
            })();
            return true;
          }
        }
        return false;
      },

      handleDOMEvents: {
        // Layout re-parenting can silently drop DOM focus to <body> while
        // ProseMirror still believes it is focused. Clicking then focuses
        // the editor, and PM's on-focus selection restore clobbers the
        // browser's caret placement with the stale state selection. Setting
        // the state selection to the clicked position first makes that
        // restore land where the user clicked.
        mousedown: (view, event) => {
          if (view.hasFocus() || event.button !== 0 || event.shiftKey) {
            return false;
          }
          const pos = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          if (!pos) return false;
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.near(view.state.doc.resolve(pos.pos)),
            ),
          );
          return false;
        },

        // openOnClick: false prevents Tiptap from opening links, but the
        // browser still navigates when clicking a rendered <a href>. Block
        // native navigation — the bubble menu's Open button is the only
        // way to follow a link.
        click: (_view, event) => {
          const target = event.target as HTMLElement;
          if (target.closest("a[href]")) {
            event.preventDefault();
          }
          return false;
        },
      },
    },
  });

  const instance: MarkdownInstance = {
    type: "markdown",
    editor,
    filePath,
    focus(): boolean {
      if (isEditorFocusSuppressed()) return false;
      this.editor.commands.focus();
      return true;
    },
    dispose(): void {
      this.editor.destroy();
    },
    isFocusable(): boolean {
      return true;
    },
    goToLocation(location: EditorLocation): boolean {
      try {
        const doc = this.editor.state.doc;
        const fullText = doc.textBetween(0, doc.content.size, "\n", "\n");
        let startPos = resolveLineColumn(doc, fullText, location.line, location.column ?? 1);
        let endPos = startPos;

        if (location.expectedText) {
          const fuzzyOffset = fuzzyFind(
            fullText,
            location.expectedText,
            startPos - 1,
          );
          if (fuzzyOffset !== -1) {
            const textStart = fullTextOffsetToTextOffset(
              fullText,
              fuzzyOffset,
            );
            const textEnd = fullTextOffsetToTextOffset(
              fullText,
              fuzzyOffset + location.expectedText.length,
            );
            startPos = textOffsetToDocPos(doc, textStart);
            endPos = textOffsetToDocPos(doc, textEnd - 1) + 1;
          }
        } else if (
          location.endLine !== undefined &&
          location.endColumn !== undefined
        ) {
          endPos = resolveLineColumn(
            doc,
            fullText,
            location.endLine,
            location.endColumn,
          );
        }

        this.editor.commands.setTextSelection({ from: startPos, to: endPos });
        this.editor.commands.scrollIntoView();
        this.editor.commands.focus();

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
 * Map a 0-indexed character offset in the document's visible text to a
 * 1-indexed ProseMirror document position. ProseMirror positions include
 * node-boundary tokens that sit before the text content, so offset + 1 is
 * not sufficient. We walk the text descendants to find the correct position.
 */
export function textOffsetToDocPos(doc: { content: { size: number }; descendants: (fn: (node: unknown, pos: number) => boolean | void) => void }, targetOffset: number): number {
  let accumulated = 0;

  let result = 1;
  doc.descendants((node: unknown, pos: number) => {
    const n = node as { isText?: boolean; text?: string; nodeSize?: number };
    if (!n.isText || typeof n.text !== "string") return;

    const len = n.text.length;
    if (targetOffset < accumulated + len) {
      result = pos + (targetOffset - accumulated);
      return false; // stop traversal
    }
    accumulated += len;
  });

  return Math.max(1, Math.min(result, doc.content.size));
}

function fullTextOffsetToTextOffset(fullText: string, offset: number): number {
  let count = 0;
  for (let i = 0; i < offset; i++) {
    if (fullText[i] === "\n") count++;
  }
  return offset - count;
}

/** Sanitize a filename for use in markdown image paths.
 * Spaces become hyphens, parentheses are removed — both break many markdown
 * parsers when used inside `![](...)` paths. */
export function normalizeImageName(name: string): string {
  return name
    .replace(/\s+/g, "-")
    .replace(/[()]/g, "");
}

/**
 * Find a name under `<workspaceRoot>/assets/` that doesn't collide with an
 * existing file, suffixing `-1`, `-2`, … before the extension. Overwriting
 * would silently swap the image in every document referencing the old path.
 */
async function dedupeAssetName(workspaceRoot: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";

  let candidate = name;
  for (let i = 1; ; i++) {
    const result = await platformAdapter.exists([`${workspaceRoot}/assets/${candidate}`]);
    if (!result[0]?.exists) return candidate;
    candidate = `${stem}-${i}${ext}`;
  }
}

export function resolveLineColumn(
  doc: { content: { size: number } },
  text: string,
  line: number,
  column: number,
): number {
  const lines = text.split("\n");
  let pos = 1;

  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    pos += lines[i].length + 1;
  }

  const lineContent = lines[line - 1] ?? "";
  pos += Math.min(column - 1, lineContent.length);

  return Math.max(1, Math.min(pos, doc.content.size));
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
  basePath?: string;
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
      instance = createMarkdownInstance(filePath, config.content, config.basePath);
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
export function getMarkdownEditor(filePath: string): Editor | undefined {
  const instance = editorInstances.get(filePath);
  if (isMarkdownInstance(instance)) {
    return instance.editor;
  }
  return undefined;
}

export function saveSelection(
  filePath: string,
  from: number,
  to: number,
): void {
  const instance = editorInstances.get(filePath);
  if (isMarkdownInstance(instance)) {
    instance.savedSelection = { from, to };
  }
}

export function getSavedSelection(filePath: string): { from: number; to: number } | undefined {
  const instance = editorInstances.get(filePath);
  if (isMarkdownInstance(instance)) {
    return instance.savedSelection;
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
    const { from, to } = instance.editor.state.selection;
    if (from === to) return undefined;

    const text = instance.editor.state.doc.textBetween(from, to, "\n");
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
