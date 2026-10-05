/**
 * The agents in core: `core.agents` is the facade (agents.ts) over a
 * runtime built here from what core hands it, and `core.workspace(ws).agents`
 * is that workspace's handle on it.
 *
 * A workspace's TaskManager is created lazily by its first task; this
 * module owns its end. Closing the workspace disposes every live task, and
 * rows with a session demote to "restored" so the next open can revive them
 * (MET-54). It needs the history repo, so it is disposed first: cancelling
 * a turn can still checkpoint there.
 */
import { defineModule } from "@notefig/core";
import { createAgentRuntime } from "./agent-service";
import {
  AGENT_KV_NAMESPACE,
  createAgents,
  type AgentsApi,
  type AgentWorkspaceHandle,
} from "./agents";
import { ensureAgentRuntime } from "./tunnel/require-connection";

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
  needs: ["agentStore", "kv", "platform", "tabs", "documents", "layout"],
  register: (ctx) => {
    const store = ctx.use("agentStore");
    const kv = ctx.use("kv");
    const { proc, fs } = ctx.use("platform");
    const documents = ctx.use("documents");
    const layout = ctx.use("layout");
    let agents: AgentsApi | null = null;
    const runtime = createAgentRuntime({
      store,
      kv,
      proc,
      fs,
      services: (workspacePath) => {
        const workspace = ctx.workspaceHandle(workspacePath);
        return {
          get history() {
            return workspace.history;
          },
          get files() {
            return workspace.files;
          },
          documents,
          layout,
        };
      },
      agents: () => agents!,
    });
    return (agents = createAgents({
      runtime,
      store,
      kv,
      openAgentTab: (taskId) => ctx.use("tabs").openAgent(taskId),
      isOpen: (workspacePath) => ctx.workspaces.isOpen(workspacePath),
      ensureRuntime: ensureAgentRuntime,
    }));
  },
  boot: (agents, ctx) => {
    // Each workspace's trust answer is read synchronously when a session
    // starts, so load them before anyone can click.
    void ctx.use("kv").collection(AGENT_KV_NAMESPACE).preload();
    // Bring persisted task rows in line with this session: rows without a
    // live runtime demote to "restored", rows with no session are dropped.
    void agents.whenReconciled();
  },
  workspace: {
    needs: ["history"],
    create: ({ workspace }, agents) => agents.workspace(workspace.path),
    dispose: (_handle, workspace, agents) =>
      agents.disposeWorkspace(workspace.path),
  },
});
