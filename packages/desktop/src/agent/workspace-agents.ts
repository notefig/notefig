/**
 * The agents of one open workspace — `core.workspace(ws).agents`.
 *
 * The workspace's TaskManager is still created lazily by the first task
 * (agent-service.ts); this module owns its end. Closing the workspace
 * disposes every live task, and rows with a session demote to "restored"
 * so the next open can revive them (MET-54). It needs the history repo,
 * so it is disposed first: cancelling a turn can still checkpoint there.
 */
import { defineModule } from "@notefig/core";
import {
  disposeWorkspaceTaskManager,
  getWorkspaceTaskManager,
} from "./agent-service";

export interface WorkspaceAgents {
  /** Ids of the workspace's live tasks (none until the first one starts).
   *  Tasks are driven by id, never held. */
  liveTaskIds(): string[];
}

declare module "@notefig/core" {
  interface WorkspaceModules {
    agents: WorkspaceAgents;
  }
}

export const workspaceAgentsModule = defineModule({
  name: "agents",
  workspace: {
    needs: ["history"],
    create: ({ workspace }) => ({
      liveTaskIds: () =>
        (getWorkspaceTaskManager(workspace.path)?.listTasks() ?? []).map(
          (task) => task.taskId,
        ),
    }),
    dispose: (_agents, workspace) =>
      disposeWorkspaceTaskManager(workspace.path),
  },
});
