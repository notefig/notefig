/**
 * The open-tabs cross-entity join (`useWorkspaceTabs`): URL layout →
 * agent/file split → per-workspace grouping + agent task rows + stale-tab
 * detection, in one hook. Callers keep layout interaction on
 * `useDockableTabs`; this is the read side.
 */
import { useMemo, useCallback, useSyncExternalStore } from "react";
import type { Core } from "@notefig/core";
import { useCore } from "@notefig/core/react";
import {
  useAgentTasksReady,
  useAgentTaskRowsById,
  type AgentTaskRow,
} from "@/modules/agents/react";
import type { WorkspaceFiles } from "@/modules/files";
import { useMetadataFetching } from "@/modules/files/react";
import type { WorkspaceRegistry } from "@/modules/workspaces";
import {
  useOpenWorkspaces,
  useOpenWorkspacesReady,
} from "@/modules/workspaces/react";
import {
  agentTabId,
  agentTaskIdFromTabId,
  isFileTabId,
  isReleaseNotesTabId,
} from "./tab-id";

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
  registry: WorkspaceRegistry,
  fileTabIds: string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of fileTabIds) {
    const workspace = registry.workspaceOf(path);
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
function useMissingFileTabs(
  fileTabsByWorkspace: Map<string, string[]>,
  fileTabIds: string[],
): string {
  const core = useCore();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscriptions = [...fileTabsByWorkspace.keys()].flatMap(
        (workspace) => {
          const files = openFilesOf(core, workspace);
          return files
            ? [files.collections.metadata.subscribeChanges(onChange)]
            : [];
        },
      );
      // A workspace core opens later brings its rows with it.
      const stopOpens = core.workspaces.subscribe(onChange);
      return () => {
        for (const subscription of subscriptions) subscription.unsubscribe();
        stopOpens();
      };
    },
    [core, fileTabsByWorkspace],
  );
  const read = useCallback(() => {
    const present = new Set<string>();
    for (const [workspace, paths] of fileTabsByWorkspace) {
      const metadata = openFilesOf(core, workspace)?.collections.metadata;
      if (!metadata) continue;
      for (const path of paths) if (metadata.has(path)) present.add(path);
    }
    return fileTabIds.filter((path) => !present.has(path)).join(",");
  }, [core, fileTabsByWorkspace, fileTabIds]);
  return useSyncExternalStore(subscribe, read, read);
}

/** A workspace's files, if core has it open (its row can load first). */
function openFilesOf(
  core: Core,
  workspace: string,
): WorkspaceFiles | undefined {
  return core.workspaces.isOpen(workspace)
    ? core.workspace(workspace).files
    : undefined;
}

/**
 * The open-tabs cross-entity join: URL layout → agent/file split → per-
 * workspace grouping + agent task rows + stale-tab detection, in one hook.
 * Callers keep layout interaction (selection, focus, hotkeys, writes) on
 * `useDockableTabs`; this is the read side. File rows are joined per tab
 * (modules/tabs/tab-types.tsx), since each tab resolves its own workspace.
 */
export function useWorkspaceTabs(openTabs: string[]): WorkspaceTabsState {
  const { agentStore, tabs, workspaceRegistry: registry } = useCore();
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
    () => groupFileTabsByWorkspace(registry, fileTabIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, fileTabIds, openWorkspaces],
  );
  const missingFileTabs = useMissingFileTabs(fileTabsByWorkspace, fileTabIds);
  // Coarse on purpose: a metadata walk in any workspace defers pruning in
  // all of them; the walk is short and pruning is not urgent. Before the
  // persisted open set has loaded, every file tab would look homeless.
  const openWorkspacesReady = useOpenWorkspacesReady();
  const isFetchingMetadata = useMetadataFetching();
  const agentTasksReady = useAgentTasksReady();

  const agentTaskRows = useAgentTaskRowsById(agentTaskIds);

  const staleTabIds = useMemo(() => {
    // File tabs wait out the metadata fetch; agent tabs wait out the tasks
    // collection's boot load (restored sessions come back as rows).
    const midRenameIds = new Set([...tabs.renaming()].flat());
    const missingFileTabIds =
      !openWorkspacesReady || isFetchingMetadata || missingFileTabs === ""
        ? []
        : missingFileTabs
            .split(",")
            // Ids mid-rename are transiently rowless by design — never stale.
            .filter((tabId) => !midRenameIds.has(tabId));
    const missingAgentTabIds = agentTasksReady
      ? agentTaskIds
          .filter((taskId) => !agentStore.tasks.get(taskId))
          .map(agentTabId)
      : [];
    return [...missingFileTabIds, ...missingAgentTabIds];
  }, [
    missingFileTabs,
    agentTaskIds,
    openWorkspacesReady,
    isFetchingMetadata,
    agentTasksReady,
    agentStore,
    tabs,
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
