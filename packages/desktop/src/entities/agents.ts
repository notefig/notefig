/**
 * Agents entity — the app-facing import point over `src/agent/`.
 *
 * `src/agent/` stays the implementation directory (service, collections,
 * transports, tools); this module re-exports the facade + collections and
 * owns the consolidated reactive hooks, so per-task joins (task row, turns,
 * entries, pending permissions) are written once instead of per component.
 */
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery, eq, and, inArray } from "@tanstack/react-db";
import {
  BUILT_IN_HARNESSES,
  buildHarnessResumeCommand,
} from "@notefig/shared/agent";
import { path as pathutil } from "@/utils/path";
import { getDesktopOs } from "@/utils/platform";
import { formatTimeAgo } from "@/utils/format";
import i18n from "@/utils/intl";
import { useActiveHarnesses } from "@/hooks/use-harness-selection";
import {
  agentTasksCollection,
  agentTurnsCollection,
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  type AgentTaskRow,
  type AgentTurn,
  type AgentEntry,
  type AgentPermissionRequestRow,
} from "@/agent/agent-collections";

// One-shot handles + actions live on the facade (identity + actions,
// re-resolved live, typed failures) — the pattern this entity layer
// generalized from.
export { agents } from "@/agent/agents";
export {
  agentTasksCollection,
  agentTurnsCollection,
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentEntriesForTask,
  agentTurnsForTask,
} from "@/agent/agent-collections";
export type {
  AgentTaskRow,
  AgentTaskStatus,
  AgentTurn,
  AgentTurnStatus,
  AgentEntry,
  AgentEntryType,
  AgentPermissionRequestRow,
} from "@/agent/agent-collections";

/** The task's collection row; undefined until it exists (or after deletion). */
export function useTaskRow(taskId: string): AgentTaskRow | undefined {
  const { data = [] } = useLiveQuery(
    (q) =>
      q
        .from({ task: agentTasksCollection })
        .where(({ task }) => eq(task.taskId, taskId)),
    [taskId],
  );
  return data[0];
}

/** Task rows for a set of ids (e.g. the open agent tabs). */
export function useAgentTaskRowsById(taskIds: string[]): AgentTaskRow[] {
  const { data = [] } = useLiveQuery(
    (q) =>
      taskIds.length === 0
        ? undefined
        : q
            .from({ task: agentTasksCollection })
            .where(({ task }) => inArray(task.taskId, taskIds)),
    [...taskIds],
  );
  return data;
}

/** All turns of a task (unsorted — order by turnId/status at the call site). */
export function useTaskTurns(taskId: string): AgentTurn[] {
  const { data = [] } = useLiveQuery(
    (q) =>
      q
        .from({ turn: agentTurnsCollection })
        .where(({ turn }) => eq(turn.taskId, taskId)),
    [taskId],
  );
  return data;
}

/** All transcript entries of a task. */
export function useTaskEntries(taskId: string): AgentEntry[] {
  const { data = [] } = useLiveQuery(
    (q) =>
      q
        .from({ entry: agentEntriesCollection })
        .where(({ entry }) => eq(entry.taskId, taskId)),
    [taskId],
  );
  return data;
}

/**
 * The task's pending permission requests, oldest first (ids sort
 * chronological: `taskId_perm_N`) — `[0]` is the head to render.
 */
export function usePendingPermissions(
  taskId: string,
): AgentPermissionRequestRow[] {
  const { data = [] } = useLiveQuery(
    (q) =>
      q
        .from({ req: agentPermissionRequestsCollection })
        .where(({ req }) =>
          and(eq(req.taskId, taskId), eq(req.status, "pending")),
        ),
    [taskId],
  );
  return useMemo(
    () => [...data].sort((a, b) => (a.id < b.id ? -1 : 1)),
    [data],
  );
}

/**
 * One workspace task with the derived state the session pickers render.
 * Owned by the sidebar sessions panel; kept as a shared hook so any future
 * session picker can't drift in ordering or status derivation.
 */
export type AgentTaskMeta = {
  task: AgentTaskRow;
  /** Turns still waiting behind the current one (status === "queued"). */
  queuedCount: number;
  isRunning: boolean;
  needsAuth: boolean;
  isError: boolean;
  /** Revival failed — the harness no longer has this session (MET-54). */
  isUnavailable: boolean;
};

/**
 * True once the storage-backed tasks collection has completed its boot load
 * (MET-54) — gates layout tab pruning so restored sessions' tabs aren't
 * dropped while the read is in flight. preload() is idempotent and resolves
 * once the first sync lands.
 */
export function useAgentTasksReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void agentTasksCollection.preload().finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

/**
 * The workspace's tasks ordered by last activity (updatedAt desc, taskId as
 * tiebreak — descending ids = newest-created first), each joined with its
 * queued-turn count.
 */
export function useAgentTaskList(workspacePath: string): AgentTaskMeta[] {
  const normalized = pathutil.normalize(workspacePath);

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
        isUnavailable: task.status === "unavailable",
      }));
  }, [tasks, queuedTurns]);
}

/**
 * The actions a session row can offer, derived from the task in one place —
 * consumers never join task rows with harness config or interpret status
 * enums themselves.
 */
export type AgentSessionActions = {
  /** The raw ACP session id (harness-minted, NOT taskId); null until the
   *  session handshake has completed. */
  sessionId: string | null;
  /** Refresh is a between-turns action only: mid-turn the session can't be
   *  reloaded (and the fork hazard says it must not be); "starting" is
   *  already a load in flight, and error/unavailable have no live session
   *  worth re-reading. */
  canRefresh: boolean;
  /** Terminal resume command from the harness's `resumeCommand` template
   *  (per-machine overrides included). `supported: false` — the harness
   *  declares no template: hide the control. `command: null` while
   *  supported — no session id yet: disable it. */
  resume: { supported: boolean; command: string | null };
};

export function useSessionActions(task: AgentTaskRow): AgentSessionActions {
  // The task's harness may be disabled or undiscovered by now — fall back
  // to the built-in definition so its sessions keep their affordances.
  const harnesses = useActiveHarnesses();
  const harness =
    harnesses.find((entry) => entry.id === task.harnessId) ??
    BUILT_IN_HARNESSES.find((entry) => entry.id === task.harnessId);
  const sessionId = task.sessionId ?? null;
  return {
    sessionId,
    canRefresh:
      task.status === "idle" ||
      task.status === "cancelled" ||
      task.status === "restored",
    resume:
      harness?.resumeCommand === undefined
        ? { supported: false, command: null }
        : {
            supported: true,
            command: sessionId
              ? buildHarnessResumeCommand(
                  harness,
                  {
                    sessionId,
                    workspacePath: task.workspacePath,
                  },
                  // The copy target is the user's default terminal:
                  // PowerShell on Windows, a POSIX shell elsewhere.
                  getDesktopOs() === "windows" ? "powershell" : "posix",
                )
              : null,
          },
  };
}

/**
 * The right-aligned meta label for a session row. Priority: sign-in blocks
 * everything else > live activity (running/queued) > failure > last touch.
 * Uses the i18n instance directly (not useTranslation) so it stays a pure
 * function callable from any consumer; consumers re-render on language
 * change through their own useTranslation subscriptions.
 */
export function describeTaskMeta(meta: AgentTaskMeta): string {
  if (meta.needsAuth) return i18n.t("agentNeedsSignIn");
  if (meta.isRunning) {
    return meta.queuedCount > 0
      ? i18n.t("agentRunningQueued", { count: meta.queuedCount })
      : i18n.t("agentRunning");
  }
  if (meta.queuedCount > 0) {
    return i18n.t("agentQueuedCount", { count: meta.queuedCount });
  }
  if (meta.isError) return i18n.t("agentFailed");
  if (meta.isUnavailable) return i18n.t("agentSessionUnavailable");
  // "restored" deliberately gets no special label — a restored session is a
  // normal session whose runtime just hasn't spawned yet (MET-54).
  return formatTimeAgo(meta.task.updatedAt);
}
