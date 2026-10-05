/**
 * Tabs entity — the dockable tab layout, its id conventions, and the handle
 * over one open tab.
 *
 * The layout itself is the `layout` module (`entities/layout.ts`); this one
 * owns what happens to tabs in it:
 *   - `tabsModule` — `core.tabs`: open, select, focus, close and rename a
 *     tab, and which tab is active. The only way the app changes tabs;
 *   - the open-tabs cross-entity join (`useWorkspaceTabs`);
 *   - `tab(tabId)` — the handle: the controls every tab type has, plus
 *     `.editor` on a file tab and `.agent` on an agent tab for the ones only
 *     that kind has;
 *   - re-exports of the two leaves it is the public face of: the pure layout
 *     codec (`utils/layout-codec`, shared with the crash-fallback debug
 *     panel) and the tab-id scheme (`tabs/tab-id`).
 */
import { useMemo, useCallback, useEffect, useSyncExternalStore } from "react";
import { defineModule } from "@notefig/core";
import type { LayoutNode } from "@/components/dockable";
import {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
} from "@/utils/layout-codec";
import {
  findFirstWindow,
  findWindowById,
  openFileInLayout,
  removeTabFromLayout,
  renameTabInLayout,
  selectTabInLayout,
  type OpenFileIntent,
} from "@/utils/dockable-layout";
import type { LayoutApi } from "./layout";
import type { FocusTiming } from "@/utils/focus-arbiter";
import {
  AGENT_TAB_PREFIX,
  RELEASE_NOTES_TAB_ID,
  agentTabId,
  agentTaskIdFromTabId,
  isAgentTabId,
  isFileTabId,
  isReleaseNotesTabId,
  parseTabId,
  tabKind,
  type TabKind,
  type TabRef,
} from "@/tabs/tab-id";
import {
  disposeTab,
  focusTab,
  getTabController,
  getTabSelectedText,
  grantTabFocusHandoff,
  isTabFocusable,
  requestTabFocus,
  revealTabMatch,
  searchTab,
  type TabSearchMatch,
  type TabSearchOptions,
} from "@/tabs/tab-controllers";
// Sibling entities — only referenced inside function bodies (cycle rule).
import { editor, type EditorHandle } from "./editors";
import {
  agents,
  agentTasksCollection,
  useAgentTasksReady,
  useAgentTaskRowsById,
  type AgentTaskRow,
} from "./agents";
import type { AgentTaskHandle } from "@/agent/agents";
import {
  getOrCreateWorkspaceCollections,
  useMetadataFetching,
  renameFileOrDirectory,
} from "./files";
import {
  useOpenWorkspaces,
  useOpenWorkspacesReady,
  workspaceOfPath,
} from "./workspaces";
import {
  flushDocumentSync,
  whenDocumentSyncClean,
} from "@/utils/markdown-conversion";
import { whenWorkspaceWritesSettled } from "@/utils/workspace-write-tracker";
// Read-side editor-store accessor, same conscious entities → components
// import as entities/editors.ts.
import { getMarkdownEditor } from "@/entities/editors";

// ---------------------------------------------------------------------------
// Public re-exports: the layout codec and the tab-id scheme.
// ---------------------------------------------------------------------------

export {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
  AGENT_TAB_PREFIX,
  RELEASE_NOTES_TAB_ID,
  agentTabId,
  agentTaskIdFromTabId,
  isAgentTabId,
  isFileTabId,
  isReleaseNotesTabId,
  parseTabId,
  tabKind,
};
export type { TabKind, TabRef, TabSearchMatch };

// ---------------------------------------------------------------------------
// The tab handle — general controls flat, type-specific ones behind `.editor`
// / `.agent`. Handles are re-resolved on every call and never cache state.
// ---------------------------------------------------------------------------

/** What every tab can do, whatever it contains. */
interface TabHandleBase {
  readonly tabId: string;
  /** Whether the tab's surface is live (mounted / instantiated). */
  isMounted(): boolean;
  isFocusable(): boolean;
  /** Move keyboard focus into the tab. Returns whether focus landed. */
  focus(): boolean;
  /** Text the user has selected inside the tab, if any. */
  selectedText(): string | undefined;
  /** Find-in-tab: occurrences of `query` in this tab's own content. */
  search(query: string, options?: TabSearchOptions): Promise<TabSearchMatch[]>;
  /** Scroll a match from `search` into view and highlight it. */
  revealMatch(match: TabSearchMatch): boolean;
}

export interface FileTabHandle extends TabHandleBase {
  readonly kind: "file";
  readonly path: string;
  /** The document controls only a file tab has (dirty state, markdown). */
  readonly editor: EditorHandle;
}

export interface AgentTabHandle extends TabHandleBase {
  readonly kind: "agent";
  readonly taskId: string;
  /** The session controls only an agent tab has (prompt, cancel, auth). */
  readonly agent: AgentTaskHandle;
}

export interface ReleaseNotesTabHandle extends TabHandleBase {
  readonly kind: "release-notes";
}

export type TabHandle = FileTabHandle | AgentTabHandle | ReleaseNotesTabHandle;

/**
 * The handle over one open tab, whether or not it is currently mounted (an
 * unmounted tab reports `isMounted() === false` and its controls no-op).
 */
export function tab(tabId: string): TabHandle {
  const base: TabHandleBase = {
    tabId,
    isMounted: () => getTabController(tabId) !== undefined,
    isFocusable: () => isTabFocusable(tabId),
    focus: () => focusTab(tabId),
    selectedText: () => getTabSelectedText(tabId),
    search: (query, options) => searchTab(tabId, query, options),
    revealMatch: (match) => revealTabMatch(tabId, match),
  };

  const ref = parseTabId(tabId);
  switch (ref.kind) {
    case "file":
      return {
        ...base,
        kind: "file",
        path: ref.path,
        editor: editor(ref.path),
      };
    case "agent":
      return {
        ...base,
        kind: "agent",
        taskId: ref.taskId,
        agent: agents.task(ref.taskId),
      };
    case "release-notes":
      return { ...base, kind: "release-notes" };
  }
}

// ---------------------------------------------------------------------------
// Rename-open-tab: the close-and-reopen primitive — any open file may be
// renamed or moved from the tree; the tab follows the file.
// ---------------------------------------------------------------------------

/**
 * Tab ids currently mid-rename. Between the collection row re-key and the
 * layout id-swap commit, the layout briefly holds an id with no backing row
 * — without this guard the stale-tab pruning would close the tab. React
 * batches renders across the orchestrator's await points, so ordering alone
 * cannot prevent that.
 */
const pendingTabRenames = new Map<string, string>();

/** oldPath → promise of the path's final location (newPath on success,
 * oldPath on failure). Programmatic writers (agent authoring) consult this
 * via `activeRenameTarget` so a write overlapping the move lands on the
 * moved file instead of resurrecting the old path. */
const pendingRenameTargets = new Map<string, Promise<string>>();

function beginTabRename(oldId: string, newId: string): void {
  pendingTabRenames.set(oldId, newId);
}

function endTabRename(oldId: string): void {
  pendingTabRenames.delete(oldId);
}

/** The path a write should target once any in-flight rename of `path`
 * settles; null when no rename is in flight. */
export function activeRenameTarget(path: string): Promise<string> | null {
  return pendingRenameTargets.get(path) ?? null;
}

/**
 * Rename/move an OPEN file tab by closing and reopening it in place: the
 * editor is disposed, the file moved once the save pipeline drains, and the
 * tab id swapped in the layout without leaving its window slot. The editor
 * remounts at the new path (undo history and caret are not preserved —
 * accepted for an explicit rename/promote gesture). Throws if the move
 * fails; the tab is left intact at the old path in that case.
 */
export async function renameOpenFileTab(options: {
  workspacePath: string;
  oldPath: string;
  newPath: string;
  /**
   * Must be the RAW id swap (`core.tabs.rename`) — `applyLayout`'s
   * removed-id diff would dispose the old id again and treat the swap as a
   * close+open.
   */
  applyLayoutRename: (oldId: string, newId: string) => void;
}): Promise<void> {
  const { workspacePath, oldPath, newPath, applyLayoutRename } = options;
  // One rename per source path at a time: the coordination entries are
  // keyed by oldPath, so a second overlapping call would overwrite the
  // first's, and whichever fails would clear the other's write redirect
  // and stale-prune guard mid-swap.
  if (pendingTabRenames.has(oldPath)) {
    throw new Error(`A rename of "${oldPath}" is already in progress`);
  }
  beginTabRename(oldPath, newPath);
  let settleTarget!: (path: string) => void;
  pendingRenameTargets.set(
    oldPath,
    new Promise<string>((resolve) => {
      settleTarget = resolve;
    }),
  );
  // Freeze the editor for the duration: an edit landing after the drain
  // would schedule a save against the old path and resurrect it post-move.
  // The editor stays alive (read-only) until the move succeeds, so a
  // failed move leaves the tab fully intact.
  const liveEditor = getMarkdownEditor(oldPath);
  liveEditor?.setEditable(false);
  try {
    flushDocumentSync(oldPath);
    await whenDocumentSyncClean(oldPath);
    // Writes that passed the redirect check before this rename began are
    // tracked in flight — drain them too before moving the file.
    await whenWorkspaceWritesSettled(oldPath);
    await renameFileOrDirectory(workspacePath, oldPath, newPath);
  } catch (error) {
    if (liveEditor && !liveEditor.isDestroyed) liveEditor.setEditable(true);
    settleTarget(oldPath);
    pendingRenameTargets.delete(oldPath);
    endTabRename(oldPath);
    throw error;
  }
  settleTarget(newPath);
  pendingRenameTargets.delete(oldPath);
  disposeTab(oldPath);
  applyLayoutRename(oldPath, newPath);
  // The guard clears from state truth, not a timer: useWorkspaceTabs ends
  // the rename once the layout no longer holds the old id (swap committed
  // or tab closed). A timer raced the URL-driven layout commit — a prune
  // render holding the pre-swap layout could clobber the swap.
}

export interface WorkspaceTabsState {
  /** Open tab ids that are files (absolute paths). */
  fileTabIds: string[];
  /** The open file tabs grouped by the open workspace that contains each —
   *  what the content watchers arm per workspace. */
  fileTabsByWorkspace: Map<string, string[]>;
  /** Task ids of open agent chat tabs (`agent:` prefix stripped). */
  agentTaskIds: string[];
  /** Task rows for the open agent tabs. */
  agentTaskRows: AgentTaskRow[];
  /** Whether the release-notes tab is in the layout. */
  isReleaseNotesTabOpen: boolean;
  /**
   * Open tab ids (file paths / `agent:<taskId>`) whose backing entity no
   * longer exists — already gated on the metadata fetch and the agent
   * collection's boot load, so a tab is never reported stale while its
   * backing load is still in flight.
   */
  staleTabIds: string[];
}

/** `fileTabIds` grouped by the workspace containing each; tabs in no open
 *  workspace are left out (they are stale). */
function groupFileTabsByWorkspace(
  fileTabIds: string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of fileTabIds) {
    const workspace = workspaceOfPath(path);
    if (workspace === null) continue;
    const group = groups.get(workspace);
    if (group) group.push(path);
    else groups.set(workspace, [path]);
  }
  return groups;
}

/**
 * The file tabs whose metadata row is missing from the workspace that
 * contains them (or that no open workspace contains), as a stable
 * comma-joined snapshot so an unchanged answer never re-renders. Subscribes
 * to every involved workspace's metadata collection — the dock is one
 * layout over every open workspace.
 */
function useMissingFileTabs(fileTabsByWorkspace: Map<string, string[]>, fileTabIds: string[]): string {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscriptions = [...fileTabsByWorkspace.keys()].map((workspace) =>
        getOrCreateWorkspaceCollections(workspace).metadata.subscribeChanges(
          onChange,
        ),
      );
      return () => {
        for (const subscription of subscriptions) subscription.unsubscribe();
      };
    },
    [fileTabsByWorkspace],
  );
  const read = useCallback(() => {
    const present = new Set<string>();
    for (const [workspace, paths] of fileTabsByWorkspace) {
      const { metadata } = getOrCreateWorkspaceCollections(workspace);
      for (const path of paths) if (metadata.has(path)) present.add(path);
    }
    return fileTabIds.filter((path) => !present.has(path)).join(",");
  }, [fileTabsByWorkspace, fileTabIds]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The open-tabs cross-entity join: URL layout → agent/file split → per-
 * workspace grouping + agent task rows + stale-tab detection, in one hook.
 * Callers keep layout interaction (selection, focus, hotkeys, writes) on
 * `useDockableTabs`; this is the read side. File rows are joined per tab
 * (tabs/tab-types.tsx), since each tab resolves its own workspace.
 */
export function useWorkspaceTabs(openTabs: string[]): WorkspaceTabsState {
  const fileTabIds = useMemo(() => openTabs.filter(isFileTabId), [openTabs]);
  const agentTaskIds = useMemo(
    () =>
      openTabs
        .map(agentTaskIdFromTabId)
        .filter((taskId): taskId is string => taskId !== null),
    [openTabs],
  );
  const isReleaseNotesTabOpen = useMemo(
    () => openTabs.some(isReleaseNotesTabId),
    [openTabs],
  );

  // Re-group when workspaces open or close, not only when tabs change.
  const openWorkspaces = useOpenWorkspaces();
  const fileTabsByWorkspace = useMemo(
    () => groupFileTabsByWorkspace(fileTabIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileTabIds, openWorkspaces],
  );
  const missingFileTabs = useMissingFileTabs(fileTabsByWorkspace, fileTabIds);
  // Coarse on purpose: a metadata walk in any workspace defers pruning in
  // all of them; the walk is short and pruning is not urgent. Before the
  // persisted open set has loaded, every file tab would look homeless.
  const openWorkspacesReady = useOpenWorkspacesReady();
  const isFetchingMetadata = useMetadataFetching();
  const agentTasksReady = useAgentTasksReady();

  const agentTaskRows = useAgentTaskRowsById(agentTaskIds);

  // End pending renames from state truth: once the layout stops holding
  // the old id (the swap committed, or the tab was closed), every render
  // from here on sees a row-backed layout and pruning is inert again.
  useEffect(() => {
    for (const oldId of pendingTabRenames.keys()) {
      if (!fileTabIds.includes(oldId)) endTabRename(oldId);
    }
  }, [fileTabIds]);

  const staleTabIds = useMemo(() => {
    // File tabs wait out the metadata fetch; agent tabs wait out the tasks
    // collection's boot load (restored sessions come back as rows).
    const midRenameIds = new Set([...pendingTabRenames].flat());
    const missingFileTabIds =
      !openWorkspacesReady || isFetchingMetadata || missingFileTabs === ""
        ? []
        : missingFileTabs
            .split(",")
            // Ids mid-rename are transiently rowless by design — never stale.
            .filter((tabId) => !midRenameIds.has(tabId));
    const missingAgentTabIds = agentTasksReady
      ? agentTaskIds
          .filter((taskId) => !agentTasksCollection.get(taskId))
          .map(agentTabId)
      : [];
    return [...missingFileTabIds, ...missingAgentTabIds];
  }, [
    missingFileTabs,
    agentTaskIds,
    openWorkspacesReady,
    isFetchingMetadata,
    agentTasksReady,
  ]);

  return {
    fileTabIds,
    fileTabsByWorkspace,
    agentTaskIds,
    agentTaskRows,
    isReleaseNotesTabOpen,
    staleTabIds,
  };
}

// ---------------------------------------------------------------------------
// core.tabs — the one way the app changes tabs.
// ---------------------------------------------------------------------------

type DockWindow = NonNullable<ReturnType<typeof findFirstWindow>>;

export interface OpenTabOptions {
  /** "replace" swaps out the target window's selected tab (default). */
  intent?: OpenFileIntent;
  /** Defaults to the active window. */
  targetWindowId?: string;
  /**
   * When the tab is already open in another window than `targetWindowId`,
   * move it there instead of selecting it in place. Only explicit placement
   * gestures (a drop onto a window) set this.
   */
  moveIfOpen?: boolean;
  /**
   * The gesture opened this tab as the thing to type into next (a created
   * file whose tree field is still open): its next focus claim may take
   * focus out of a live text entry. One-shot.
   */
  handoff?: boolean;
  /**
   * Change other search params in the same navigation, for a write that
   * must land atomically with the open (closing the settings modal as a
   * tab opens from it).
   */
  params?: (params: URLSearchParams) => void;
}

export interface TabFocusRequest {
  /**
   * "now" (default) focuses synchronously and reports whether it landed.
   * The arbiter's timings file an intent instead ("when-mounted" keeps it
   * until the tab's surface is up) and return false.
   */
  when?: "now" | FocusTiming;
  /** An explicit user hand-off; ambient claims never steal focus. */
  steal?: boolean;
  reason?: string;
}

export interface TabsApi {
  /**
   * Open a tab, or select it if it is open. Returns false for a file the
   * editor cannot open. A tab the open replaces is disposed.
   */
  open(tabId: string, options?: OpenTabOptions): boolean;
  /** Open (or select) an agent session's chat tab, always as a new tab. */
  openAgent(taskId: string): void;
  /** Make an open tab its window's selected tab. */
  select(tabId: string): void;
  /** Move keyboard focus into a tab. */
  focus(tabId: string, request?: TabFocusRequest): boolean;
  close(tabId: string): void;
  /** Swap a tab id in place, without disposing (rename-open-tab flow). */
  rename(oldId: string, newId: string): void;
  /** Take a layout the dock produced (drag, close), disposing removed tabs. */
  applyLayout(next: LayoutNode[]): void;
  /** The selected tab of the active window. */
  activeTabId(): string | null;
  activeWindowId(): string | null;
  /** The active window's tabs, in order. */
  activeWindowTabs(): string[];
  /** Called when the layout or the focused window changes. */
  subscribe(listener: () => void): () => void;
}

declare module "@notefig/core" {
  interface CoreModules {
    tabs: TabsApi;
  }
}

const WINDOW_ID_ATTRIBUTE = "data-dockable-window-id";

function windowIdOf(element: Element | null): string | null {
  return (
    element?.closest<HTMLElement>(`[${WINDOW_ID_ATTRIBUTE}]`)?.dataset
      .dockableWindowId ?? null
  );
}

/** The dock window that last held focus, kept after focus leaves the dock. */
function createFocusedWindow() {
  let windowId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => windowId,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    track(): () => void {
      const onFocusIn = (event: FocusEvent) => {
        const next = windowIdOf(event.target as Element | null);
        if (!next || next === windowId) return;
        windowId = next;
        for (const listener of [...listeners]) listener();
      };
      document.addEventListener("focusin", onFocusIn);
      return () => document.removeEventListener("focusin", onFocusIn);
    },
  };
}

export function createTabs(
  layout: LayoutApi,
  focusedWindow: Pick<
    ReturnType<typeof createFocusedWindow>,
    "get" | "subscribe"
  >,
  canOpenFile: (path: string) => boolean,
): TabsApi {
  /** Focus inside the dock first, then the window that last had it, then
   *  the layout's selection, then the first window. */
  const activeWindow = (): DockWindow | null => {
    const current = layout.read();
    const focusedNow = windowIdOf(document.activeElement);
    if (focusedNow) {
      const window = findWindowById(current, focusedNow);
      if (window) return window;
    }
    const remembered = focusedWindow.get();
    if (remembered) {
      const window = findWindowById(current, remembered);
      if (window) return window;
    }
    const selected = layout.selectedTabId();
    if (selected) {
      const window = current.find(
        (node) => "selected" in node && node.selected === selected,
      );
      if (window && "selected" in window) return window as DockWindow;
    }
    return findFirstWindow(current);
  };

  const tabs: TabsApi = {
    open(tabId, options = {}) {
      // Only file tabs are gated on the editor's format support; the other
      // tab kinds carry their own content.
      if (tabKind(tabId) === "file" && !canOpenFile(tabId)) return false;
      const targetWindowId =
        options.targetWindowId ?? activeWindow()?.id ?? undefined;
      layout.update(
        (current) => {
          const next = openFileInLayout(current, {
            tabId,
            intent: options.intent ?? "replace",
            targetWindowId,
            moveIfOpen: options.moveIfOpen,
          });
          // "replace" drops the target window's selected tab, and a tab that
          // leaves the layout must be disposed. disposeTab is idempotent.
          const nextIds = extractTabIds(next);
          for (const id of extractTabIds(current)) {
            if (!nextIds.includes(id)) disposeTab(id);
          }
          return next;
        },
        { params: options.params },
      );
      if (options.handoff) grantTabFocusHandoff(tabId);
      return true;
    },
    openAgent(taskId) {
      // A session must never replace the file tab in view.
      tabs.open(agentTabId(taskId), { intent: "new-tab" });
    },
    select(tabId) {
      if (!layout.openTabIds().includes(tabId)) return;
      layout.update((current) => selectTabInLayout(current, tabId));
    },
    focus(tabId, request = {}) {
      const when = request.when ?? "now";
      if (when === "now") return focusTab(tabId);
      requestTabFocus(tabId, {
        when,
        reason: request.reason,
        steal: request.steal,
      });
      return false;
    },
    close(tabId) {
      if (!layout.openTabIds().includes(tabId)) return;
      disposeTab(tabId);
      layout.update((current) => removeTabFromLayout(current, tabId));
    },
    rename(oldId, newId) {
      layout.update((current) => renameTabInLayout(current, oldId, newId));
    },
    applyLayout(next) {
      const nextIds = extractTabIds(next);
      for (const id of layout.openTabIds()) {
        if (!nextIds.includes(id)) disposeTab(id);
      }
      layout.update(next);
    },
    activeTabId: () => activeWindow()?.selected ?? layout.selectedTabId(),
    activeWindowId: () => activeWindow()?.id ?? null,
    activeWindowTabs: () => activeWindow()?.children ?? [],
    subscribe(listener) {
      const offLayout = layout.subscribe(listener);
      const offFocus = focusedWindow.subscribe(listener);
      return () => {
        offLayout();
        offFocus();
      };
    },
  };
  return tabs;
}

/**
 * `canOpenFile` is the editor's format gate. It is passed in by the
 * composition root so this entity does not import editor components.
 */
export function tabsModule({
  canOpenFile,
}: {
  canOpenFile: (path: string) => boolean;
}) {
  const focusedWindow = createFocusedWindow();
  return defineModule({
    name: "tabs",
    needs: ["layout"],
    register: (ctx) =>
      createTabs(ctx.use("layout"), focusedWindow, canOpenFile),
    boot: () => focusedWindow.track(),
  });
}
