/**
 * Tabs entity — the dockable tab layout, its id conventions, and the handle
 * over one open tab.
 *
 * The layout's single source of truth is the URL (`?layout=<json>`); there
 * is no registry to construct or dispose. This module owns:
 *   - the reactive layout hook (`useLayoutSearchParam`) and the open-tabs
 *     cross-entity join (`useWorkspaceTabs`);
 *   - `tab(tabId)` — the handle: the controls every tab type has, plus
 *     `.editor` on a file tab and `.agent` on an agent tab for the ones only
 *     that kind has;
 *   - re-exports of the two leaves it is the public face of: the pure layout
 *     codec (`utils/layout-codec`, shared with the crash-fallback debug
 *     panel) and the tab-id scheme (`tabs/tab-id`).
 *
 * The imperative reads (`readLayout`/`readOpenTabIds`/`readActiveTabId`) are
 * for one-shot, non-reactive callers — agent tools, prompt composers. They
 * parse `window.location` fresh on every call; reactive UI must go through
 * `useLayoutSearchParam`/`useDockableTabs`.
 */
import { useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { LayoutNode } from "@/components/dockable";
import {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
  readLayout,
  readOpenTabIds,
  readActiveTabId,
} from "@/utils/layout-codec";
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
  isTabFocusable,
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
  useOpenFileRows,
  useMetadataFetching,
  renameFileOrDirectory,
  type OpenFileRow,
} from "./files";
import {
  flushDocumentSync,
  whenDocumentSyncClean,
} from "@/utils/markdown-conversion";
// Read-side editor-store accessor, same conscious entities → components
// import as entities/editors.ts.
import { getMarkdownEditor } from "@/components/editor/editor-store";

// ---------------------------------------------------------------------------
// Public re-exports: the layout codec and the tab-id scheme.
// ---------------------------------------------------------------------------

export {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
  readLayout,
  readOpenTabIds,
  readActiveTabId,
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

export interface UseLayoutSearchParam {
  /** The full Dockable layout tree from the URL */
  layout: LayoutNode[];
  /** Write a new layout to the URL (pushes history entry) */
  setLayout: (
    nextLayout: LayoutNode[] | ((currentLayout: LayoutNode[]) => LayoutNode[]),
  ) => void;
  /** All tab IDs extracted from the layout */
  openTabs: string[];
  /** Layout-derived selected tab ID (first selected window), or null */
  layoutSelectedTabId: string | null;
}

/**
 * Hook that stores the Dockable LayoutNode[] in a URL search param
 * (`?layout=<json>`). The URL is the single source of truth.
 *
 * Other search params (e.g. `settings`) are preserved.
 */
export function useLayoutSearchParam(): UseLayoutSearchParam {
  const [searchParams, setUrlSearchParams] = useSearchParams();
  const layoutParam = searchParams.get(LAYOUT_PARAM);

  const layout = useMemo(() => parseLayout(layoutParam), [layoutParam]);

  const setLayout = useCallback(
    (
      nextLayout:
        LayoutNode[] | ((currentLayout: LayoutNode[]) => LayoutNode[]),
    ) => {
      setUrlSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        const currentLayout = parseLayout(next.get(LAYOUT_PARAM));
        const resolvedLayout =
          typeof nextLayout === "function"
            ? nextLayout(currentLayout)
            : nextLayout;

        if (resolvedLayout.length === 0) {
          next.delete(LAYOUT_PARAM);
        } else {
          next.set(LAYOUT_PARAM, JSON.stringify(resolvedLayout));
        }

        return next;
      });
    },
    [setUrlSearchParams],
  );

  const openTabs = useMemo(() => extractTabIds(layout), [layout]);
  const layoutSelectedTabId = useMemo(
    () => findLayoutSelectedTab(layout),
    [layout],
  );

  return { layout, setLayout, openTabs, layoutSelectedTabId };
}

// ---------------------------------------------------------------------------
// Rename-open-tab: the close-and-reopen primitive (MET-135 promotion).
// ---------------------------------------------------------------------------

/**
 * Tab ids currently mid-rename. Between the collection row re-key and the
 * layout id-swap commit, the layout briefly holds an id with no backing row
 * — without this guard the stale-tab pruning would close the tab. React
 * batches renders across the orchestrator's await points, so ordering alone
 * cannot prevent that.
 */
const pendingTabRenames = new Set<string>();

function beginTabRename(oldId: string, newId: string): void {
  pendingTabRenames.add(oldId);
  pendingTabRenames.add(newId);
}

function endTabRename(oldId: string, newId: string): void {
  pendingTabRenames.delete(oldId);
  pendingTabRenames.delete(newId);
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
   * Must be the RAW layout write (`setLayout(l => renameTabInLayout(...))`)
   * — handleLayoutChange's removed-id diff would dispose the old id again
   * and treat the swap as a close+open.
   */
  applyLayoutRename: (oldId: string, newId: string) => void;
}): Promise<void> {
  const { workspacePath, oldPath, newPath, applyLayoutRename } = options;
  beginTabRename(oldPath, newPath);
  // Freeze the editor for the duration: an edit landing after the drain
  // would schedule a save against the old path and resurrect it post-move.
  // The editor stays alive (read-only) until the move succeeds, so a
  // failed move leaves the tab fully intact.
  const liveEditor = getMarkdownEditor(oldPath);
  liveEditor?.setEditable(false);
  try {
    flushDocumentSync(oldPath);
    await whenDocumentSyncClean(oldPath);
    await renameFileOrDirectory(workspacePath, oldPath, newPath);
  } catch (error) {
    if (liveEditor && !liveEditor.isDestroyed) liveEditor.setEditable(true);
    endTabRename(oldPath, newPath);
    throw error;
  }
  disposeTab(oldPath);
  applyLayoutRename(oldPath, newPath);
  // Outlive the render that commits the layout write; after it, layout id
  // and row agree and pruning is inert again.
  setTimeout(() => endTabRename(oldPath, newPath), 0);
}

export interface WorkspaceTabsState {
  /** Open tab ids that are files (real workspace paths). */
  fileTabIds: string[];
  /** Task ids of open agent chat tabs (`agent:` prefix stripped). */
  agentTaskIds: string[];
  /** Metadata ⋈ content rows for the open file tabs. */
  fileRows: OpenFileRow[];
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

/**
 * The open-tabs cross-entity join: URL layout → agent/file split → file
 * rows + agent task rows + stale-tab detection, in one hook. Callers keep
 * layout interaction (selection, focus, hotkeys, writes) on
 * `useDockableTabs`; this is the read side.
 */
export function useWorkspaceTabs(
  workspacePath: string,
  openTabs: string[],
): WorkspaceTabsState {
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

  const fileRows = useOpenFileRows(workspacePath, fileTabIds);
  const isFetchingMetadata = useMetadataFetching(workspacePath);
  const agentTasksReady = useAgentTasksReady();

  const agentTaskRows = useAgentTaskRowsById(agentTaskIds);

  const staleTabIds = useMemo(() => {
    // File tabs wait out the metadata fetch; agent tabs wait out the tasks
    // collection's boot load (restored sessions come back as rows).
    const existingFilePaths = new Set(fileRows.map((row) => row.path));
    const missingFileTabIds = isFetchingMetadata
      ? []
      : fileTabIds.filter(
          // Ids mid-rename are transiently rowless by design — never stale.
          (tabId) =>
            !existingFilePaths.has(tabId) && !pendingTabRenames.has(tabId),
        );
    const missingAgentTabIds = agentTasksReady
      ? agentTaskIds
          .filter((taskId) => !agentTasksCollection.get(taskId))
          .map(agentTabId)
      : [];
    return [...missingFileTabIds, ...missingAgentTabIds];
  }, [fileRows, fileTabIds, agentTaskIds, isFetchingMetadata, agentTasksReady]);

  return {
    fileTabIds,
    agentTaskIds,
    fileRows,
    agentTaskRows,
    isReleaseNotesTabOpen,
    staleTabIds,
  };
}
