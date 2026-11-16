/**
 * The focused workspace follows the tab in front (MET-290). The sidebar,
 * new-item actions and the status bar's sync cell go by the focused
 * workspace; the rest of the status bar goes by the active tab. When a tab
 * of another open workspace comes to the front, that workspace is focused,
 * so the two never disagree.
 *
 * Only a change of active tab moves focus: choosing a workspace in the rail
 * leaves the tabs as they are, and that choice stands until another tab is
 * chosen. A tab outside every open workspace (release notes, a file of a
 * closed one) moves nothing.
 */
import { defineModule } from "@notefig/core";
import { agentStoreModule } from "@/modules/agents/agent-collections";
import { tabsModule, type TabsApi } from "@/modules/tabs";
import { agentTaskIdFromTabId, fileTabPath } from "@/modules/tabs/tab-id";
import { mostRecentlyFocused, workspacesModule, type WorkspaceRegistry } from "@/modules/workspaces";
import { workspaceKey } from "@/utils/path";

export interface WorkspaceFollowsTabDeps {
  tabs: Pick<TabsApi, "activeTabId" | "subscribe">;
  registry: Pick<WorkspaceRegistry, "collection" | "whenReady" | "workspaceOf" | "isOpen">;
  /** Agent task rows by id (`agentStore.tasks`). */
  tasks: { get(taskId: string): { workspacePath: string } | undefined };
  /** Bring a workspace to the front, as the rail does. */
  focus(workspacePath: string): Promise<void>;
}

/** The open workspace a tab belongs to: a file's, or an agent's. */
function workspaceOfTab(tabId: string, { registry, tasks }: WorkspaceFollowsTabDeps): string | null {
  const file = fileTabPath(tabId);
  if (file !== null) return registry.workspaceOf(file);
  const taskId = agentTaskIdFromTabId(tabId);
  const workspace = taskId === null ? undefined : tasks.get(taskId)?.workspacePath;
  return workspace && registry.isOpen(workspace) ? workspace : null;
}

/** Focus the active tab's workspace whenever the active tab changes, and
 *  once the open set is restored. Returns the unsubscribe. */
export function followActiveTab(deps: WorkspaceFollowsTabDeps): () => void {
  let ready = false;
  let shown: string | null = null;
  const follow = () => {
    const tabId = deps.tabs.activeTabId();
    if (!ready || tabId === shown) return;
    shown = tabId;
    const target = tabId === null ? null : workspaceOfTab(tabId, deps);
    const focused = mostRecentlyFocused(deps.registry.collection.values());
    if (target === null || (focused && workspaceKey(focused.path) === workspaceKey(target))) return;
    deps.focus(target).catch((error: unknown) => console.error(`Couldn't focus ${target}:`, error));
  };
  const off = deps.tabs.subscribe(follow);
  void deps.registry.whenReady().then(() => {
    ready = true;
    follow();
  });
  return off;
}

declare module "@notefig/core" {
  interface CoreModules {
    "workspace-follows-tab": undefined;
  }
}

export const workspaceFollowsTabModule = defineModule({
  name: "workspace-follows-tab",
  needs: [tabsModule, workspacesModule, agentStoreModule],
  boot: (_api, ctx) =>
    followActiveTab({
      tabs: ctx.use("tabs"),
      registry: ctx.use("workspaceRegistry"),
      tasks: ctx.use("agentStore").tasks,
      focus: (workspacePath) => ctx.workspaceHandle(workspacePath).focus(),
    }),
});
