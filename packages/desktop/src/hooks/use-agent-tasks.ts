import { useMemo } from "react";
import { useLiveQuery, eq } from "@tanstack/react-db";
import {
  agentTasksCollection,
  agentTurnsCollection,
  type AgentTaskRow,
} from "@/agent/agent-collections";
import { normalizePath } from "@/utils/fs";
import { formatTimeAgo } from "@/utils/format";

/**
 * One workspace task with the derived state the session pickers render.
 * Shared by the panel's session switcher and the floating prompt (⌘I) so
 * the two lists can't drift in ordering or status derivation.
 */
export type AgentTaskMeta = {
  task: AgentTaskRow;
  /** Turns still waiting behind the current one (status === "queued"). */
  queuedCount: number;
  isRunning: boolean;
  needsAuth: boolean;
  isError: boolean;
};

/**
 * The workspace's tasks ordered by last activity (updatedAt desc, taskId as
 * tiebreak — descending ids = newest-created first), each joined with its
 * queued-turn count.
 */
export function useAgentTaskList(workspacePath: string): AgentTaskMeta[] {
  const normalized = normalizePath(workspacePath);

  const { data: tasks = [] } = useLiveQuery(
    (q) =>
      q
        .from({ task: agentTasksCollection })
        .where(({ task }) => eq(task.workspacePath, normalized)),
    [normalized],
  );
  const { data: queuedTurns = [] } = useLiveQuery((q) =>
    q
      .from({ turn: agentTurnsCollection })
      .where(({ turn }) => eq(turn.status, "queued")),
  );

  return useMemo(() => {
    const queuedByTask = new Map<string, number>();
    for (const turn of queuedTurns) {
      queuedByTask.set(turn.taskId, (queuedByTask.get(turn.taskId) ?? 0) + 1);
    }
    return [...tasks]
      .sort((a, b) =>
        a.updatedAt !== b.updatedAt
          ? b.updatedAt - a.updatedAt
          : a.taskId < b.taskId
            ? -1
            : 1,
      )
      .map((task) => ({
        task,
        queuedCount: queuedByTask.get(task.taskId) ?? 0,
        isRunning: task.status === "running",
        needsAuth: !!task.authRequired,
        isError: task.status === "error",
      }));
  }, [tasks, queuedTurns]);
}

/**
 * The right-aligned meta label for a session row. Priority: sign-in blocks
 * everything else > live activity (running/queued) > failure > last touch.
 */
export function describeTaskMeta(meta: AgentTaskMeta): string {
  if (meta.needsAuth) return "needs sign-in";
  if (meta.isRunning) {
    return meta.queuedCount > 0
      ? `running · ${meta.queuedCount} queued`
      : "running";
  }
  if (meta.queuedCount > 0) return `${meta.queuedCount} queued`;
  if (meta.isError) return "failed";
  return formatTimeAgo(meta.task.updatedAt);
}
