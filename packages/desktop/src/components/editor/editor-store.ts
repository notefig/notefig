/**
 * Editor instance factory: builds the Tiptap editor for a document and the
 * container instances for image, code and release-notes tabs, registers
 * each with the editors the surface was handed (`core.editors`,
 * `entities/editors.ts`) and publishes its tab controller. Everything that
 * only looks an editor up goes through that instance.
 */

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  editorExtensions,
  MarkdownImage,
  MarkdownCodeBlock,
} from "@/components/editor/tiptap-editor-kit";
import {
  editorWidgets,
  widgetRendererNodes,
  widgetMinimapExtension,
  PageLinkSuggestion,
} from "@notefig/widgets";
import { lowlight } from "@/components/editor/editor-schema-kit";
import {
  closeDocumentSync,
  flushDocumentSync,
  getDocumentSync,
} from "@/utils/markdown-conversion";
import {
  isSidebarTextEntryActive,
  isTextEntryActive,
} from "@/utils/focus-arbiter";
import {
  registerTabController,
  unregisterTabController,
  type TabController,
  type TabFocusOptions,
  type TabSearchOptions,
} from "@/tabs/tab-controllers";
import type { TabKind } from "@/tabs/tab-id";
import { resolveSearchTarget, type SearchTarget } from "./editor-position";
import { createMarkdownCodec } from "./markdown-codec";
import {
  isBlockTarget,
  isMarkdownInstance,
  type EditorInstance,
  type EditorsApi,
  type EditorTarget,
  type EditorType,
  type MarkdownInstance,
} from "@/entities/editors";
import { pageLinkHref } from "./tiptap-link-utils";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { getDirectoryPath } from "@/utils/fs";
import {
  createImageDropHandler,
  createImagePasteHandler,
} from "./editor-image-paste";
import {
  composeDropHandlers,
  createProtocolDropHandler,
} from "@/utils/drag-protocol";

export type { SearchTarget };

const markdownCodec = createMarkdownCodec();

/**
 * Delegates for read-only code viewers. The viewer is a plain React
 * component (no instance object of its own lives here), so it registers
 * the operations that need its DOM on mount: match reveal (dispatched by
 * the code instance's `goToLocation`) and reading the user's text
 * selection out of the CodeView shadow root (dispatched by
 * `getSelectedText`, which seeds Mod+F / Mod+Shift+F). Keyed by file path
 * like the instance map.
 */
export interface CodeViewerDelegate {
  revealMatch(target: SearchTarget): boolean;
  selectedText(): string | undefined;
}

const codeViewerDelegates = new Map<string, CodeViewerDelegate>();

export function registerCodeViewerDelegate(
  filePath: string,
  delegate: CodeViewerDelegate,
): void {
  codeViewerDelegates.set(filePath, delegate);
}

export function unregisterCodeViewerDelegate(filePath: string): void {
  codeViewerDelegates.delete(filePath);
}

/** Diagnostic hook for e2e failure dumps (dev builds only), over the
 *  editors the first surface was handed. */
function installDebugSeam(editors: EditorsApi): void {
  if (!import.meta.env.DEV) return;
  const host = window as unknown as Record<string, unknown>;
  if (host.__metristsDebugEditors) return;
  host.__metristsDebugEditors = () =>
    editors.paths().map((path) => {
      const instance = editors.instance(path)!;
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

/** How long a block jump waits for its widget's node view to render. */
const BLOCK_RENDER_WAIT_MS = 2_000;

/**
 * The rendered element of a widget block (`data-blob-id`, set by the
 * prompt widget and code-block blob node views) inside this editor, once
 * it exists. Node views can render after the editor mounts, so a missing
 * block is watched for, not polled — and only inside this editor's DOM.
 */
export function whenBlockRendered(
  editor: Pick<Editor, "view">,
  blockId: string,
): Promise<HTMLElement | null> {
  const root = editor.view.dom;
  const selector = `[data-blob-id="${CSS.escape(blockId)}"]`;
  const found = root.querySelector<HTMLElement>(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const element = root.querySelector<HTMLElement>(selector);
      if (!element) return;
      finish(element);
    });
    const timer = setTimeout(() => finish(null), BLOCK_RENDER_WAIT_MS);
    const finish = (element: HTMLElement | null) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(element);
    };
    // Attributes too: an existing wrapper can gain its id after render.
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-blob-id"],
    });
  });
}

/** Scroll a block into view and ring it briefly so the eye finds it. */
function flashBlock(element: HTMLElement): void {
  element.scrollIntoView({ block: "center" });
  // Inline style, not a class: a dynamically-added class name wouldn't be
  // picked up by Tailwind's static JIT scan.
  const previousTransition = element.style.transition;
  const previousBoxShadow = element.style.boxShadow;
  element.style.transition = "box-shadow 0.2s ease";
  element.style.boxShadow = "0 0 0 2px var(--ring, #3b82f6)";
  setTimeout(() => {
    element.style.boxShadow = previousBoxShadow;
    setTimeout(() => {
      element.style.transition = previousTransition;
    }, 300);
  }, 1500);
}

/** Sidebar text entry (rename/create) outranks any editor focus intent. */
function isEditorFocusSuppressed(): boolean {
  return isSidebarTextEntryActive(document.activeElement);
}

/**
 * A text entry other than `filePath`'s own ProseMirror surface holds focus —
 * a sidebar rename field, the chat tab's composer. The widget's draft is
 * part of this surface, not a foreign entry, so it is covered by the
 * `active === view.dom` check like any other text in the document.
 */
function isForeignTextEntryFocused(
  editors: Pick<EditorsApi, "instance">,
  filePath: string,
): boolean {
  const active = document.activeElement;
  const instance = editors.instance(filePath);
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
 * The `TabController` an open document (or a container-only tab such as the
 * image viewer / release notes) presents to the rest of the app. The
 * instance map stays private: everything above this file addresses a
 * document through its tab id like any other tab.
 */
/** The platform fs an editor reaches: in-document search, and the image
 *  assets a paste or drop writes. */
export type EditorFs = Pick<
  FileSystemSurface,
  "searchContent" | "exists" | "writeBinaryFiles"
>;

function createEditorTabController(
  editors: EditorsApi,
  filePath: string,
  kind: TabKind,
  fs: Pick<EditorFs, "searchContent">,
): TabController {
  return {
    tabId: filePath,
    kind,

    /**
     * Ambient intents (editor mount, layout reclaim, tab activation) must
     * not yank focus out of an active text entry — toggling the sidebar
     * re-parents the dock, remounts the editor, and its mount intent used
     * to steal a rename field's focus mid-typing (MET-93). Intents marked
     * `steal` proceed; `when-mounted` intents keep retrying until the entry
     * releases focus or their TTL expires.
     *
     * The prompt widget needs no carve-out here any more: its draft is
     * document content, so focusing the editor and restoring its selection
     * IS focusing the composer.
     */
    focus({ steal }: TabFocusOptions = {}): boolean {
      if (!steal && isForeignTextEntryFocused(editors, filePath)) return false;
      return editors.instance(filePath)?.focus(steal) ?? false;
    },

    isFocusable: () => editors.instance(filePath)?.isFocusable() ?? false,

    selectedText: () => editors.instance(filePath)?.selectedText(),

    // Flushes the autosave window and closes the document sync — the tab is
    // gone, so the instance must not outlive it.
    dispose: () => disposeEditor(editors, filePath),

    /**
     * Find-in-document, through the same file search the workspace search
     * panel uses — scoped to this one file. `revealMatch` below re-locates
     * whatever it returns in the rendered document, which is exactly what
     * the {matchText, lineText, occurrence} shape exists for.
     */
    async search(
      query: string,
      options?: TabSearchOptions,
    ): Promise<SearchTarget[]> {
      // Documents and code viewers have searchable text; an image viewer
      // has none.
      const instance = editors.instance(filePath);
      if (!isMarkdownInstance(instance) && instance?.type !== "code") {
        return [];
      }
      if (!query.trim()) return [];

      return fs.searchContent(getDirectoryPath(filePath), {
        query,
        caseSensitive: options?.caseSensitive,
        fileIncludes: [filePath],
      });
    },

    revealMatch: (match: SearchTarget) => editors.goTo(filePath, match),

    get history() {
      // Only documents have an edit history; image/release-notes tabs
      // report none, so the palette's undo/redo stays inert on them.
      const instance = editors.instance(filePath);
      if (!isMarkdownInstance(instance)) return undefined;
      return {
        undo: () => instance.editor.commands.undo(),
        redo: () => instance.editor.commands.redo(),
      };
    },
  };
}

/** Every node name the widget registry contributes — the widgets themselves
 *  and the support nodes their content expressions need (the prompt's draft,
 *  the mention chip). The per-document rebuild below drops all of them from
 *  the shared kit's unconfigured copy and re-adds the configured set, so a
 *  support node must be named here too or it would be registered twice. */
const widgetNames = new Set(
  editorWidgets.flatMap((widget) => [
    widget.name,
    ...(widget.support?.bases ?? []).map((node) => node.name),
  ]),
);

function createMarkdownInstance(
  filePath: string,
  // Doc JSON only — all markdown parsing goes through the conversion worker
  // (utils/markdown-conversion.ts) before an editor is ever created.
  content: JSONContent,
  basePath: string | undefined,
  fs: EditorFs,
): MarkdownInstance {
  const workspaceRoot = basePath || getDirectoryPath(filePath);

  const extensions = [
    ...editorExtensions.filter(
      (e) =>
        e.name !== "image" &&
        e.name !== "codeBlock" &&
        !widgetNames.has(e.name),
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
    // filePath/basePath scope the widgets to this document and its
    // workspace; they also arm the prompt widget's empty-doc keeper
    // (unconfigured schema-only instances never self-insert).
    ...widgetRendererNodes({ filePath, basePath: workspaceRoot }),
    // "@" page links (MET-78) in ordinary prose — the complement of the
    // prompt widget's draft-scoped mention suggestion, sharing its popup.
    // The href policy is the app's (tiptap-link-utils), injected whole.
    PageLinkSuggestion.configure({
      documentPath: filePath,
      buildHref: (relativePath) =>
        pageLinkHref(filePath, workspaceRoot, relativePath),
    }),
    // The document minimap rail (MET-172) — mounts its own UI inside the
    // editor's scroll container; registering it is the installation.
    widgetMinimapExtension(),
  ];

  const editor = new Editor({
    extensions,
    content,
    editable: true,
    autofocus: false,
    editorProps: {
      // Protocol handler first — consumes tagged drags, falls through for
      // internal moves and payload-less drags (OS image drops).
      // Assets are written and referenced relative to the document itself
      // (`<fileDir>/assets/`), matching how image srcs are resolved.
      handleDrop: composeDropHandlers(
        createProtocolDropHandler(),
        createImageDropHandler(fs, getDirectoryPath(filePath)),
      ),
      handlePaste: createImagePasteHandler(fs, getDirectoryPath(filePath)),

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
    focus(steal?: boolean): boolean {
      // A sidebar rename/create field outranks an AMBIENT editor intent —
      // but not an explicit hand-off. Creating a file opens that field and
      // opens the new document's prompt at the same time; the prompt is the
      // document's entry point (focus-management.spec.ts), so its claim is
      // deliberate and says so with `steal`.
      if (!steal && isEditorFocusSuppressed()) return false;
      // Never move the viewport: taking focus is ambient (tab select, mount,
      // Escape out of a widget) and the caret is often nowhere near what the
      // user is reading — a tab kept its scroll position precisely so that
      // coming back to it doesn't jump. Navigation that IS meant to move the
      // viewport goes through goToLocation.
      this.editor.commands.focus(null, { scrollIntoView: false });
      return true;
    },
    dispose(): void {
      this.editor.destroy();
    },
    isFocusable(): boolean {
      return true;
    },
    async goTo(target: EditorTarget): Promise<boolean> {
      if (isBlockTarget(target)) {
        const block = await whenBlockRendered(this.editor, target.blockId);
        if (!block) return false;
        flashBlock(block);
        return true;
      }
      try {
        const { from, to } = resolveSearchTarget(this.editor.state.doc, target);

        this.editor.commands.setTextSelection({ from, to });
        this.editor.commands.scrollIntoView();
        this.editor.commands.focus();

        return true;
      } catch (error) {
        console.error("Navigation failed:", error);
        return false;
      }
    },
    selectedText(): string | undefined {
      const { from, to } = this.editor.state.selection;
      if (from === to) return undefined;
      const text = this.editor.state.doc.textBetween(from, to, "\n");
      return text.trim() ? text : undefined;
    },
    markdown(): string {
      return markdownCodec.serialize(this.editor.getJSON());
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
  type: "image" | "release-notes" | "code",
  filePath: string,
): EditorInstance {
  const instance: EditorInstance & { filePath: string } = {
    type,
    filePath,
    focus(): boolean {
      if (isEditorFocusSuppressed()) return false;

      // The path lands inside an attribute selector, so its metacharacters
      // (quotes, and every backslash in a Windows path) must be escaped or
      // querySelector throws and the tab never takes focus.
      const selector = `[data-editor-container="${CSS.escape(filePath)}"]`;
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
    async goTo(target: EditorTarget): Promise<boolean> {
      // Read-only code viewers can reveal matches; the other container
      // tabs (image, release notes) have no searchable surface.
      if (type !== "code" || isBlockTarget(target)) return false;
      return codeViewerDelegates.get(filePath)?.revealMatch(target) ?? false;
    },
    selectedText(): string | undefined {
      return type === "code"
        ? codeViewerDelegates.get(filePath)?.selectedText()
        : undefined;
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

interface CodeConfig {
  type: "code";
}

type EditorConfig =
  MarkdownConfig | ImageConfig | ReleaseNotesConfig | CodeConfig;

/**
 * Get an existing editor for a file path, or create one with the given configuration.
 * This is the main singleton pattern entry point - editors are cached by file path
 * and survive across component mount/unmount cycles.
 *
 * If an editor already exists for the path:
 * - And the type matches, returns the existing instance
 * - And the type doesn't match, disposes the old and creates new
 *
 * @param editors - The registry the surface fills (`useModule("editors")`)
 * @param filePath - The absolute file path (used as the cache key)
 * @param config - Editor configuration including type and type-specific options
 * @param fs - The platform fs the editor reaches (`usePlatform().fs`)
 * @returns The editor instance (cast to appropriate type by caller)
 */
export function getOrCreateEditor(
  editors: EditorsApi,
  filePath: string,
  config: EditorConfig,
  fs: EditorFs,
): EditorInstance {
  installDebugSeam(editors);
  const existing = editors.instance(filePath);
  if (existing) {
    if (existing.type === config.type) {
      return existing;
    }
    existing.dispose();
    editors.unregister(filePath);
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
        fs,
      );
      break;
    case "image":
    case "release-notes":
    case "code":
      instance = createContainerInstance(config.type, filePath);
      break;
    default:
      throw new Error(`Unknown editor type: ${(config as any).type}`);
  }

  editors.register(filePath, instance);
  // The tab is live from here on: publish its controller so focus intents,
  // find-in-tab and dispose reach it through the generic tab layer.
  registerTabController(
    createEditorTabController(
      editors,
      filePath,
      config.type === "release-notes" ? "release-notes" : "file",
      fs,
    ),
  );
  return instance;
}

/**
 * Dispose an editor instance when a tab is permanently closed.
 * This frees the memory held by the editor.
 */
export function disposeEditor(editors: EditorsApi, filePath: string): void {
  const instance = editors.instance(filePath);
  unregisterTabController(filePath);
  if (instance) {
    // Flush the autosave debounce window while the editor can still be
    // snapshotted — the file-sync hook's teardown runs after destroy on
    // this path and would have to drop those edits.
    flushDocumentSync(filePath);
    instance.dispose();
    editors.unregister(filePath);
    closeDocumentSync(filePath);
  }
}

/**
 * Dispose all editors (e.g. when switching workspaces).
 */
export function disposeAllEditors(editors: EditorsApi): void {
  for (const filePath of editors.paths()) disposeEditor(editors, filePath);
}

type Registry = Pick<EditorsApi, "instance">;

export function saveSelection(
  editors: Registry,
  filePath: string,
  from: number,
  to: number,
): void {
  const instance = editors.instance(filePath);
  if (isMarkdownInstance(instance)) {
    instance.savedSelection = { from, to };
  }
}

export function getSavedSelection(
  editors: Registry,
  filePath: string,
): { from: number; to: number } | undefined {
  const instance = editors.instance(filePath);
  if (isMarkdownInstance(instance)) {
    return instance.savedSelection;
  }
  return undefined;
}

export function saveViewport(
  editors: Registry,
  filePath: string,
  pos: number,
): void {
  const instance = editors.instance(filePath);
  if (isMarkdownInstance(instance)) {
    instance.savedViewport = pos;
  }
}

export function getSavedViewport(
  editors: Registry,
  filePath: string,
): number | undefined {
  const instance = editors.instance(filePath);
  return isMarkdownInstance(instance) ? instance.savedViewport : undefined;
}
