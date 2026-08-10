/**
 * Editor Instance Store
 *
 * Maintains a unified registry of markdown editors and image viewers.
 * Each type implements a common interface with polymorphic methods.
 */

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  editorExtensions,
  MarkdownImage,
  MarkdownCodeBlock,
} from "@/components/editor/tiptap-editor-kit";
import { AiPromptNode } from "@/components/editor/ai-prompt-node";
import { lowlight } from "@/components/editor/editor-schema-kit";
import {
  closeDocumentSync,
  flushDocumentSync,
  getDocumentSync,
} from "@/utils/markdown-conversion";
import { focusArbiter } from "@/utils/focus-arbiter";
import {
  isSidebarTextEntryActive,
  isTextEntryActive,
  type EditorCaretPlacement,
} from "@/utils/focus-arbiter";
import { resolveSearchTarget, type SearchTarget } from "./editor-position";
import { docHasRealContent, findPromptNodeId } from "./ai-prompt-utils";
import { requestPromptBlobFocus } from "@/components/agent/prompt-blob-store";
import { placeCaretBeforeNode } from "./refocus-editor";
import {
  createImageDropHandler,
  createImagePasteHandler,
} from "./editor-image-paste";
import {
  composeDropHandlers,
  createProtocolDropHandler,
} from "@/utils/drag-protocol";

export type { SearchTarget };

import type { EditorType } from "./polymorphic-editor";

/**
 * Base interface that all editor instances must implement
 */
export interface EditorInstance {
  readonly type: EditorType;
  /**
   * Focus this editor. Returns true if focus was attempted, false if not applicable.
   * For non-focusable editors (images), this is a no-op that returns false.
   * `caret` is the intent's placement hint (see EditorCaretPlacement);
   * without one, the current selection is left untouched.
   */
  focus(caret?: EditorCaretPlacement): boolean;
  /**
   * Dispose of this editor instance. Cleans up any resources.
   */
  dispose(): void;
  /**
   * Returns true if this editor type supports focus operations.
   */
  isFocusable(): boolean;
  /**
   * Navigate to a search match in the editor.
   * Sets cursor/selection and scrolls the location into view.
   * @param target - The match's text, line content and occurrence index
   * @returns true if navigation succeeded, false if not applicable
   */
  goToLocation(target: SearchTarget): boolean;
}

/**
 * Markdown editor instance using Tiptap
 */
export interface MarkdownInstance extends EditorInstance {
  readonly type: "markdown";
  readonly editor: Editor;
  filePath: string;
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

/**
 * Path-keyed saved selections, deliberately OUTSIDE the instances: a tab
 * replace dedupes the already-open tab by disposing and recreating its
 * editor, so anything stored on the instance (including a selection a
 * search navigation just made) dies with it. The mount lifecycle restores
 * from here into whichever instance currently backs the path.
 */
const savedSelections = new Map<string, { from: number; to: number }>();

if (import.meta.env.DEV) {
  // Diagnostic hook for e2e failure dumps (dev builds only).
  (window as unknown as Record<string, unknown>).__metristsDebugEditors = () =>
    Array.from(editorInstances.entries()).map(([path, instance]) => {
      const editor = isMarkdownInstance(instance) ? instance.editor : undefined;
      return {
        path,
        type: instance.type,
        destroyed: editor?.isDestroyed,
        docLength: editor?.state.doc.textContent.length,
        docHead: editor?.state.doc.textContent.slice(0, 40),
      };
    });
}

const EDITOR_FOCUS_PRIORITY = 70;

let observedFocusIntentId: string | null = null;
let observedFocusResult = false;

function focusEditorPath(
  filePath: string,
  caret?: EditorCaretPlacement,
): boolean {
  const instance = editorInstances.get(filePath);
  if (!instance) return false;

  return instance.focus(caret);
}

/**
 * A text entry other than `filePath`'s own ProseMirror surface holds focus.
 * The widget composer is a textarea INSIDE that surface but still a
 * distinct entry — only the contenteditable root itself counts as "own".
 */
function isForeignTextEntryFocused(filePath: string): boolean {
  const active = document.activeElement;
  const instance = editorInstances.get(filePath);
  if (instance && isMarkdownInstance(instance)) {
    try {
      if (active === instance.editor.view.dom) return false;
    } catch {
      // Detached view (mid-remount) — nothing to compare against.
    }
  }
  return isTextEntryActive(active);
}

/**
 * An empty document carrying the keeper widget: the composer is the
 * document's entry point there, so ambient editor focus must stand down.
 * Returns the keeper's blobId so the caller can forward focus to it.
 */
function emptyKeeperDocPromptId(filePath: string): string | null {
  const instance = editorInstances.get(filePath);
  if (!instance || !isMarkdownInstance(instance)) return null;
  const doc = instance.editor.state.doc;
  if (docHasRealContent(doc)) return null;
  return findPromptNodeId(doc);
}

focusArbiter.registerResolver("editor", (intent) => {
  if (intent.target.type !== "editor") return false;

  // Mirror the element resolver's rule: ambient intents (editor mount,
  // layout reclaim, tab activation) must not yank focus out of an active
  // text entry — toggling the sidebar re-parents the dock, remounts the
  // editor, and its mount intent used to steal the widget composer's
  // focus mid-typing (MET-93). Intents marked `steal` (an explicit
  // hand-off like the blob's Escape) proceed; when-mounted intents keep
  // retrying until the entry releases focus or their TTL expires.
  if (!intent.steal && isForeignTextEntryFocused(intent.target.filePath)) {
    return false;
  }

  // On an empty doc the keeper's composer owns focus by default — ambient
  // intents (mount, tab activation, post-mount reclaim) must not race it,
  // even while focus momentarily sits on <body> (rAF gap before the
  // textarea focuses, tab-layout re-parenting). Forward the intent to the
  // composer rather than just declining: on a tab re-activation nothing
  // else routes focus there (the reclaim loop only watches <body>), and
  // returning true retires the intent instead of leaving a when-mounted
  // retry loop spinning. The pending-focus channel covers a widget that
  // hasn't mounted yet. Explicit hand-offs like the blob's Escape carry
  // `steal` and still land in the editor.
  if (!intent.steal) {
    const keeperId = emptyKeeperDocPromptId(intent.target.filePath);
    if (keeperId) {
      requestPromptBlobFocus(keeperId);
      if (observedFocusIntentId === intent.id) {
        observedFocusResult = true;
      }
      return true;
    }
  }

  const result = focusEditorPath(intent.target.filePath, intent.target.caret);
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
    caret?: EditorCaretPlacement;
    steal?: boolean;
  } = {},
): string {
  return focusArbiter.request({
    domain: "editor",
    target: { type: "editor", filePath, caret: options.caret },
    steal: options.steal,
    priority: EDITOR_FOCUS_PRIORITY,
    reason: options.reason ?? "editor-focus",
    when: options.when ?? "immediate",
  });
}

function createMarkdownInstance(
  filePath: string,
  // Doc JSON only — all markdown parsing goes through the conversion worker
  // (utils/markdown-conversion.ts) before an editor is ever created.
  content: JSONContent,
  basePath?: string,
): MarkdownInstance {
  const workspaceRoot =
    basePath || filePath.substring(0, filePath.lastIndexOf("/")) || "/";

  const extensions = [
    ...editorExtensions.filter(
      (e) =>
        e.name !== "image" && e.name !== "codeBlock" && e.name !== "aiPrompt",
    ),
    // filePath lets the image node view declare its drag-protocol payload
    // (which document to rewrite when the asset is moved elsewhere).
    MarkdownImage.configure({
      allowBase64: true,
      workspaceRoot,
      filePath,
    } as any),
    // filePath lets BlobNodeView address answerBlob at the right document;
    // lowlight must be re-specified since configure() replaces options wholesale.
    MarkdownCodeBlock.configure({ lowlight, filePath } as any),
    // filePath/basePath scope the inline prompt widget to this document and
    // its workspace; they also arm the empty-doc keeper (unconfigured
    // schema-only instances never self-insert).
    AiPromptNode.configure({ filePath, basePath: workspaceRoot }),
  ];

  const editor = new Editor({
    extensions,
    content,
    editable: true,
    autofocus: false,
    editorProps: {
      // Protocol handler first — consumes tagged drags, falls through for
      // internal moves and payload-less drags (OS image drops).
      handleDrop: composeDropHandlers(
        createProtocolDropHandler(),
        createImageDropHandler(workspaceRoot),
      ),
      handlePaste: createImagePasteHandler(workspaceRoot),

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
    focus(caret?: EditorCaretPlacement): boolean {
      if (isEditorFocusSuppressed()) return false;
      if (caret?.type === "before-node") {
        placeCaretBeforeNode(this.editor, caret.pos);
      }
      this.editor.commands.focus();
      return true;
    },
    dispose(): void {
      this.editor.destroy();
    },
    isFocusable(): boolean {
      return true;
    },
    goToLocation(target: SearchTarget): boolean {
      try {
        const { from, to } = resolveSearchTarget(this.editor.state.doc, target);

        this.editor.commands.setTextSelection({ from, to });
        this.editor.commands.scrollIntoView();
        this.editor.commands.focus();

        // Navigation may run against a background tab's instance moments
        // before a tab replace disposes and recreates it; the recreated
        // editor restores the saved selection on mount, so navigation must
        // define it — otherwise the pre-switch caret wins.
        saveSelection(this.filePath, from, to);

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
 * Focus-only instance for tabs without a ProseMirror surface (image viewer,
 * release-notes tab): focus lands on the tab's `[data-editor-container]`
 * element, which keeps the dockable hotkeys alive and lets the arbiter's
 * tab-selected intents resolve like any editor's.
 */
function createContainerInstance(
  type: "image" | "release-notes",
  filePath: string,
): EditorInstance {
  const instance: EditorInstance & { filePath: string } = {
    type,
    filePath,
    focus(): boolean {
      if (isEditorFocusSuppressed()) return false;

      const selector = `[data-editor-container="${filePath}"]`;
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement) {
        el.focus();
        return true;
      }
      return false;
    },
    dispose(): void {},
    isFocusable(): boolean {
      return true;
    },
    goToLocation(_target: SearchTarget): boolean {
      return false;
    },
  };
  return instance;
}

interface MarkdownConfig {
  type: "markdown";
  /** Parsed doc JSON; may be omitted only when the editor already exists. */
  content?: JSONContent;
  basePath?: string;
}

interface ImageConfig {
  type: "image";
}

interface ReleaseNotesConfig {
  type: "release-notes";
}

type EditorConfig = MarkdownConfig | ImageConfig | ReleaseNotesConfig;

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
    if (existing.type === config.type) {
      return existing;
    }
    existing.dispose();
  }

  let instance: EditorInstance;

  switch (config.type) {
    case "markdown":
      if (!config.content) {
        // Creating on empty content would let an autosave overwrite the
        // real file with an empty document — fail loudly instead.
        throw new Error(
          `Markdown editor for ${filePath} requires a parsed document`,
        );
      }
      instance = createMarkdownInstance(
        filePath,
        config.content,
        config.basePath,
      );
      break;
    case "image":
    case "release-notes":
      instance = createContainerInstance(config.type, filePath);
      break;
    default:
      throw new Error(`Unknown editor type: ${(config as any).type}`);
  }

  editorInstances.set(filePath, instance);
  return instance;
}

export function isMarkdownInstance(
  instance: EditorInstance | undefined,
): instance is MarkdownInstance {
  return instance?.type === "markdown";
}

export function isImageInstance(
  instance: EditorInstance | undefined,
): instance is ImageInstance {
  return instance?.type === "image";
}

export function getEditor(filePath: string): EditorInstance | undefined {
  return editorInstances.get(filePath);
}

export function hasEditor(filePath: string): boolean {
  return editorInstances.has(filePath);
}

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
    // Flush the autosave debounce window while the editor can still be
    // snapshotted — the file-sync hook's teardown runs after destroy on
    // this path and would have to drop those edits.
    flushDocumentSync(filePath);
    instance.dispose();
    editorInstances.delete(filePath);
    closeDocumentSync(filePath);
  }
}

/**
 * Dispose all editors (e.g. when switching workspaces).
 */
export function disposeAllEditors(): void {
  editorInstances.forEach((instance, filePath) => {
    flushDocumentSync(filePath);
    instance.dispose();
    closeDocumentSync(filePath);
  });
  editorInstances.clear();
  // Paths belong to the closing workspace; positions are meaningless in
  // the next one. (Per-file disposeEditor deliberately keeps its entry —
  // tab dedupe recreates the editor and must restore through it.)
  savedSelections.clear();
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
  savedSelections.set(filePath, { from, to });
}

export function getSavedSelection(
  filePath: string,
): { from: number; to: number } | undefined {
  return savedSelections.get(filePath);
}

export function getAllEditorPaths(): string[] {
  return Array.from(editorInstances.keys());
}

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
 * Navigate to a search match in an editor.
 * Convenience wrapper: looks up the editor and calls goToLocation.
 *
 * @param filePath - The file path of the editor
 * @param target - The match's text, line content and occurrence index
 * @returns true if navigation succeeded, false if editor doesn't exist or navigation failed
 */
export function navigateToLocation(
  filePath: string,
  target: SearchTarget,
): boolean {
  const instance = editorInstances.get(filePath);
  if (!instance) {
    console.warn(`No editor instance found for path: ${filePath}`);
    return false;
  }
  return instance.goToLocation(target);
}
