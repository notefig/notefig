/**
 * Editors entity — the registry of live editor instances, and `core.editors`
 * over it: reach a document's editor and move it to a location, whether or
 * not its surface is up yet.
 *
 * The instances themselves are built by the tab surfaces
 * (`components/editor/editor-store.ts` assembles the Tiptap editor, code and
 * image viewers register container instances); they register here and say
 * when their surface is mounted. Everything else — tabs, agent tools, the
 * search panel — goes through this module and never imports a component.
 *
 * "Mounted" is the moment an instance can act on its DOM: the editor's view
 * is attached, or the code viewer's delegates are registered. A `goTo` that
 * arrives before that waits for it (bounded), which replaces the old pending
 * navigation intent and the blob jump's DOM polling.
 */
import type { Editor } from "@tiptap/core";
import { defineModule } from "@notefig/core";
import type { SearchTarget } from "@/adapters/platform-adapter.interface";
import type { LayoutApi } from "./layout";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { extractTabIds, findLayoutSelectedTab } from "@/utils/layout-codec";
import { relativeTreePath } from "@/utils/path";
import type { OpenTabOptions, TabsApi } from "./tabs";

// "release-notes" never comes from a file — it's the bundled release-notes
// tab, registered so the focus arbiter can drive it.
export type EditorType = "markdown" | "image" | "release-notes" | "code";

/**
 * Where to move an editor to: a search match (its text, line content and
 * occurrence index), or a widget block by its id (`data-blob-id`).
 */
export type EditorTarget = SearchTarget | { blockId: string };

export function isBlockTarget(
  target: EditorTarget,
): target is { blockId: string } {
  return "blockId" in target;
}

/** What every live editor instance implements. */
export interface EditorInstance {
  readonly type: EditorType;
  /**
   * Focus this editor, leaving its selection untouched. `steal` marks an
   * explicit hand-off, which may take focus from a text entry that an
   * ambient intent would stand down for. Returns whether focus was taken.
   */
  focus(steal?: boolean): boolean;
  dispose(): void;
  isFocusable(): boolean;
  /**
   * Move to a location: set the selection and scroll it into view. Only
   * called on a mounted instance. Async because a widget block may render
   * after the editor itself does.
   */
  goTo(target: EditorTarget): Promise<boolean>;
  /** Text the user has selected, if any. */
  selectedText(): string | undefined;
}

export interface MarkdownInstance extends EditorInstance {
  readonly type: "markdown";
  readonly editor: Editor;
  readonly filePath: string;
  /** The live document serialized to markdown. */
  markdown(): string;
  savedSelection?: { from: number; to: number };
  /** Document position last seen at the top of the visible area — see
   *  `use-editor-viewport-memory`. */
  savedViewport?: number;
}

export function isMarkdownInstance(
  instance: EditorInstance | undefined,
): instance is MarkdownInstance {
  return instance?.type === "markdown";
}

// ---------------------------------------------------------------------------
// The registry. Module scope like the tab-controller registry it pairs
// with: the surfaces that fill it render outside any core-aware context.
// ---------------------------------------------------------------------------

const instances = new Map<string, EditorInstance>();
const mounted = new Set<string>();
const mountWaiters = new Map<string, Set<() => void>>();

/** How long a `goTo` waits for its editor to mount before giving up. */
export const MOUNT_WAIT_MS = 5_000;

export function registerEditorInstance(
  filePath: string,
  instance: EditorInstance,
): void {
  instances.set(filePath, instance);
}

/** Forget an instance (it was disposed). Its surface counts as unmounted. */
export function unregisterEditorInstance(filePath: string): void {
  instances.delete(filePath);
  mounted.delete(filePath);
}

export function getEditorInstance(
  filePath: string,
): EditorInstance | undefined {
  return instances.get(filePath);
}

export function getMarkdownEditor(filePath: string): Editor | undefined {
  const instance = instances.get(filePath);
  return isMarkdownInstance(instance) ? instance.editor : undefined;
}

export function getAllEditorPaths(): string[] {
  return [...instances.keys()];
}

export function getSelectedText(filePath: string): string | undefined {
  return instances.get(filePath)?.selectedText();
}

export function isEditorFocusable(filePath: string): boolean {
  return instances.get(filePath)?.isFocusable() ?? false;
}

/** The surface for `filePath` can act on its DOM now. */
export function markEditorMounted(filePath: string): void {
  if (!instances.has(filePath)) return;
  mounted.add(filePath);
  const waiters = mountWaiters.get(filePath);
  if (!waiters) return;
  mountWaiters.delete(filePath);
  for (const resolve of waiters) resolve();
}

export function markEditorUnmounted(filePath: string): void {
  mounted.delete(filePath);
}

export function isEditorMounted(filePath: string): boolean {
  return mounted.has(filePath);
}

/**
 * The instance once its surface is mounted — now if it already is — or
 * undefined if that does not happen within `timeoutMs`. A file whose tab is
 * replaced away and reopened is disposed and recreated; this resolves with
 * whichever instance mounts next, so a location set on the old one is
 * never lost with it.
 */
export function whenEditorMounted(
  filePath: string,
  timeoutMs = MOUNT_WAIT_MS,
): Promise<EditorInstance | undefined> {
  if (mounted.has(filePath)) return Promise.resolve(instances.get(filePath));
  return new Promise((resolve) => {
    let waiters = mountWaiters.get(filePath);
    if (!waiters) {
      waiters = new Set();
      mountWaiters.set(filePath, waiters);
    }
    const onMounted = () => {
      clearTimeout(timer);
      resolve(instances.get(filePath));
    };
    const timer = setTimeout(() => {
      waiters.delete(onMounted);
      if (waiters.size === 0) mountWaiters.delete(filePath);
      resolve(undefined);
    }, timeoutMs);
    waiters.add(onMounted);
  });
}

/** Move a file's editor to `target`, waiting for it to mount if needed. */
export async function goToInEditor(
  filePath: string,
  target: EditorTarget,
  timeoutMs = MOUNT_WAIT_MS,
): Promise<boolean> {
  const instance = await whenEditorMounted(filePath, timeoutMs);
  return instance ? instance.goTo(target) : false;
}

/** Test-only: drop every instance, mount mark and waiter. */
export function resetEditorRegistryForTest(): void {
  instances.clear();
  mounted.clear();
  mountWaiters.clear();
}

// ---------------------------------------------------------------------------
// The handle — the file-tab-specific half of a tab's API (`tab(id).editor`).
// ---------------------------------------------------------------------------

export interface EditorHandle {
  readonly filePath: string;
  /** Whether a live editor instance exists for this file. */
  isMounted(): boolean;
  /** Unsaved-changes state, from the document-sync layer. */
  isDirty(): boolean;
  isFocusable(): boolean;
  /** Serialized markdown of the live document; undefined for non-markdown editors. */
  markdownText(): string | undefined;
  selectedText(): string | undefined;
  /** Move to a location, waiting for the editor to mount if needed. */
  goTo(target: EditorTarget): Promise<boolean>;
}

export function editor(filePath: string): EditorHandle {
  return {
    filePath,
    isMounted: () => instances.has(filePath),
    isDirty: () => getDocumentSync(filePath).isDirty(),
    isFocusable: () => isEditorFocusable(filePath),
    markdownText: () => {
      const instance = instances.get(filePath);
      return isMarkdownInstance(instance) ? instance.markdown() : undefined;
    },
    selectedText: () => getSelectedText(filePath),
    goTo: (target) => goToInEditor(filePath, target),
  };
}

// ---------------------------------------------------------------------------
// core.editors
// ---------------------------------------------------------------------------

export interface EditorsApi {
  /** The handle over a file's editor, mounted or not. */
  get(filePath: string): EditorHandle;
  /**
   * Open the file as a tab (or select it) and move its editor to
   * `target` once it is mounted. False when the file cannot be opened or
   * the location is not found.
   */
  reveal(
    filePath: string,
    target: EditorTarget,
    options?: OpenTabOptions,
  ): Promise<boolean>;
}

declare module "@notefig/core" {
  interface CoreModules {
    editors: EditorsApi;
  }
}

export function createEditors(tabs: Pick<TabsApi, "open">): EditorsApi {
  return {
    get: editor,
    async reveal(filePath, target, options) {
      if (!tabs.open(filePath, options)) return false;
      return goToInEditor(filePath, target);
    },
  };
}

export const editorsModule = defineModule({
  name: "editors",
  needs: ["tabs"],
  register: (ctx) => createEditors(ctx.use("tabs")),
});

// ---------------------------------------------------------------------------
// One-shot editor context for agent tools.
// ---------------------------------------------------------------------------

export interface WorkspaceEditorContext {
  openFiles: Array<{ path: string; dirty: boolean; active: boolean }>;
  activeFile: string | null;
  /** Coarse for Stage 1: whether the active file has a non-empty selection. */
  selection?: boolean;
}

/**
 * Read-only snapshot of what the user has open, scoped to one workspace.
 * Read from `core.layout` rather than a React hook, so non-React callers
 * (agent tools, the prompt composer) can call it directly. Not reactive:
 * callers that need live updates go through `useLayout`/`useDockableTabs`.
 */
export function getWorkspaceEditorContext(
  layoutApi: Pick<LayoutApi, "read">,
  workspacePath: string,
): WorkspaceEditorContext {
  const layout = layoutApi.read();
  const activeFile = findLayoutSelectedTab(layout);
  // Tree membership, not a string prefix: the layout is one dock over every
  // open workspace, and `/ws-backup` must not read as inside `/ws`.
  const inWorkspace = (path: string) =>
    relativeTreePath(workspacePath, path) !== undefined;

  const openFiles = extractTabIds(layout)
    .filter(inWorkspace)
    .map((path) => ({
      path,
      dirty: editor(path).isDirty(),
      active: path === activeFile,
    }));

  return {
    openFiles,
    activeFile: activeFile && inWorkspace(activeFile) ? activeFile : null,
    selection: activeFile
      ? getSelectedText(activeFile) !== undefined
      : undefined,
  };
}
