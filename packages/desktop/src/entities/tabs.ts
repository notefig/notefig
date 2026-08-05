/**
 * Tabs entity — the dockable tab layout and its id conventions.
 *
 * The layout's single source of truth is the URL (`?layout=<json>`); there
 * is no registry to construct or dispose. This module owns:
 *   - the pure layout codec (parse/extract/find), shared by the reactive
 *     hook (`useLayoutSearchParam`) and non-React callers;
 *   - the `agent:<taskId>` tab-id convention (tab ids are workspace file
 *     paths by default; the prefix keeps agent chat tabs out of every
 *     file-path code path);
 *   - the blessed imperative reads (`readLayout`/`readOpenTabIds`/
 *     `readActiveTabId`) for one-shot, non-reactive callers — agent tools,
 *     prompt composers. These parse `window.location` fresh on every call;
 *     reactive UI must go through `useLayoutSearchParam`/`useDockableTabs`.
 */
import { useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { LayoutNode } from "@/components/dockable";
import {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
} from "@/utils/layout-codec";
// Sibling entities — only referenced inside hook bodies (cycle rule).
import {
  useOpenFileRows,
  useMetadataFetching,
  type OpenFileRow,
} from "./files";
import {
  agentTasksCollection,
  useAgentTasksReady,
  useAgentTaskRowsById,
  type AgentTaskRow,
} from "./agents";

// ---------------------------------------------------------------------------
// Pure layout codec — lives in the layout-codec leaf (so the crash-fallback
// debug panel can share it without importing entity modules); re-exported
// here as the entity's public API.
// ---------------------------------------------------------------------------

export { LAYOUT_PARAM, parseLayout, extractTabIds, findLayoutSelectedTab };

export const AGENT_TAB_PREFIX = "agent:";

/** Singleton release-notes tab. */
export const RELEASE_NOTES_TAB_ID = "release:";

export function agentTabId(taskId: string): string {
  return `${AGENT_TAB_PREFIX}${taskId}`;
}

export function isAgentTabId(tabId: string): boolean {
  return tabId.startsWith(AGENT_TAB_PREFIX);
}

export function agentTaskIdFromTabId(tabId: string): string | null {
  return isAgentTabId(tabId) ? tabId.slice(AGENT_TAB_PREFIX.length) : null;
}

export function isReleaseNotesTabId(tabId: string): boolean {
  return tabId === RELEASE_NOTES_TAB_ID;
}

export type TabRef =
  | { type: "file"; path: string }
  | { type: "agent"; taskId: string }
  | { type: "release-notes" };

/**
 * The single place that knows the tab-id encoding. Ids with a known scheme
 * prefix are non-file tabs; everything else is a workspace file path (file
 * paths are absolute, so they can never collide with a scheme).
 */
export function parseTabId(tabId: string): TabRef {
  if (isReleaseNotesTabId(tabId)) {
    return { type: "release-notes" };
  }
  const taskId = agentTaskIdFromTabId(tabId);
  if (taskId !== null) {
    return { type: "agent", taskId };
  }
  return { type: "file", path: tabId };
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
        | LayoutNode[]
        | ((currentLayout: LayoutNode[]) => LayoutNode[]),
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
  const fileTabIds = useMemo(
    () => openTabs.filter((tabId) => parseTabId(tabId).type === "file"),
    [openTabs],
  );
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
      : fileTabIds.filter((tabId) => !existingFilePaths.has(tabId));
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

export function readLayout(): LayoutNode[] {
  const params = new URLSearchParams(window.location.search);
  return parseLayout(params.get(LAYOUT_PARAM));
}

export function readOpenTabIds(): string[] {
  return extractTabIds(readLayout());
}

export function readActiveTabId(): string | null {
  return findLayoutSelectedTab(readLayout());
}
