/**
 * The agents in core: `core.agents` is the facade (agents.ts), and
 * `core.workspace(ws).agents` is that workspace's handle on it.
 *
 * The workspace's TaskManager is still created lazily by the first task
 * (agent-service.ts); this module owns its end. Closing the workspace
 * disposes every live task, and rows with a session demote to "restored"
 * so the next open can revive them (MET-54). It needs the history repo,
 * so it is disposed first: cancelling a turn can still checkpoint there.
 */
import { defineModule } from "@notefig/core";
import { disposeWorkspaceTaskManager } from "./agent-service";
import { getOrCreateKvCollection } from "@/utils/kv-store";
import {
  AGENT_KV_NAMESPACE,
  agents,
  type AgentsApi,
  type AgentWorkspaceHandle,
} from "./agents";

declare module "@notefig/core" {
  interface CoreModules {
    agents: AgentsApi;
  }
  interface WorkspaceModules {
    agents: AgentWorkspaceHandle;
  }
}

export const workspaceAgentsModule = defineModule({
  name: "agents",
  register: () => agents,
  // Each workspace's trust answer is read synchronously when a session
  // starts, so load them before anyone can click.
  boot: () => void getOrCreateKvCollection(AGENT_KV_NAMESPACE).preload(),
  workspace: {
    needs: ["history"],
    create: ({ workspace }) => agents.workspace(workspace.path),
    dispose: (_agents, workspace) =>
      disposeWorkspaceTaskManager(workspace.path),
  },
});
