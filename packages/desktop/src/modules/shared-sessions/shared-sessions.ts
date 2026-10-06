/**
 * The shared per-workspace session all prompt blobs queue into. Lazily
 * started on the first blob send (default harness) and reused across every
 * widget — the agent task already FIFO-queues turns, so concurrent
 * widgets just line up. The rotate control replaces the shared session with
 * a fresh one; the old task is never cancelled here (it stays alive and
 * visible in the sessions panel, and any widget bound to one of its turns
 * keeps watching it). `core.sharedSessions`, kept for the app's run:
 * reopening a workspace finds its restored session again.
 */
import type { HarnessDefinition } from "@notefig/shared/agent";
import { defineModule } from "@notefig/core";
import { workspaceKey } from "@/utils/path";
import type { AgentTasksCollection } from "@/modules/agents/agent-collections";
import type { AgentsApi } from "@/modules/agents/agents";
import { workspaceAgentsModule } from "@/modules/agents/workspace-agents";
import { agentStoreModule } from "@/modules/agents/agent-collections";

type SharedSession = { taskId: string; started: Promise<void> };

export interface SharedSessionsApi {
  /**
   * The session blob prompts should target, starting one if needed.
   * Resolves once the session is ready to prompt (prompting before the ACP
   * handshake completes would settle the turn as an error).
   */
  getOrStart(
    workspacePath: string,
    harness: HarnessDefinition,
  ): Promise<{ taskId: string }>;
  /**
   * Forget the shared session (the "new session" control): the next send
   * lazily starts a fresh one. Deliberately no eager spawn — rotating
   * without ever sending shouldn't leave an idle process behind. The old
   * task is not cancelled; it stays in the sessions panel.
   */
  drop(workspacePath: string): void;
  /** Point the shared session at an existing live task (the
   *  session-picker path). No-op if the task row is missing or terminal. */
  adopt(workspacePath: string, taskId: string): void;
  /** Current shared session's taskId, if one is live — for rendering only. */
  peek(workspacePath: string): string | null;
}

export function createSharedSessions({
  agents,
  tasks,
}: {
  agents: Pick<AgentsApi, "workspace">;
  tasks: Pick<AgentTasksCollection, "get">;
}): SharedSessionsApi {
  const sessions = new Map<string, SharedSession>();

  /** A cached session is only reusable while its task row is still live.
   *  "restored" counts as live — prompting it revives via session/load. */
  const isLive = (taskId: string) => {
    const row = tasks.get(taskId);
    return (
      row !== undefined &&
      row.status !== "error" &&
      row.status !== "cancelled" &&
      row.status !== "unavailable"
    );
  };

  return {
    async getOrStart(workspacePath, harness) {
      const key = workspaceKey(workspacePath);
      let session = sessions.get(key);
      if (!session || !isLive(session.taskId)) {
        session = agents.workspace(workspacePath).startTask(harness);
        sessions.set(key, session);
      }
      await session.started;
      return { taskId: session.taskId };
    },
    drop(workspacePath) {
      sessions.delete(workspaceKey(workspacePath));
    },
    adopt(workspacePath, taskId) {
      if (!isLive(taskId)) return;
      sessions.set(workspaceKey(workspacePath), {
        taskId,
        started: Promise.resolve(),
      });
    },
    peek(workspacePath) {
      const session = sessions.get(workspaceKey(workspacePath));
      return session && isLive(session.taskId) ? session.taskId : null;
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    sharedSessions: SharedSessionsApi;
  }
}

export const sharedSessionsModule = defineModule({
  name: "sharedSessions",
  needs: [workspaceAgentsModule, agentStoreModule],
  register: (ctx) =>
    createSharedSessions({
      agents: ctx.use("agents"),
      tasks: ctx.use("agentStore").tasks,
    }),
});
