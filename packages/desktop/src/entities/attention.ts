/**
 * Attention — what the app should point the user at, derived.
 *
 * Nothing announces "needs attention". Every participating entity keeps
 * the durable fact it already owns — a task row's `lastSettled`, a prompt
 * round's `settledAt`, a pending permission, the auth flag — and this
 * module joins those against `seen` (when the user last looked at where
 * the thing lives). A new participant adds a row field and a case here;
 * it never registers, emits, or stores a mark of its own.
 *
 * Two kinds, in two colours:
 *  - **bau** — a turn finished; the blue dot. Clears when looked at.
 *  - **error** — the amber the prompt widget uses for issues. A failed
 *    turn, a harness that never came up, a session that has gone: each
 *    clears when looked at, and a later failure marks it again. Only a
 *    session that is *asking* (permission, sign-in) clears when answered.
 *
 * A widget round lands on its document, never on its session: the widget
 * is where the user is pointed, so the session stays quiet. The service
 * only announces settles; which target a settle is news for is decided
 * here, by the listener that can see the prompt-round rows — so a widget's
 * settle never overwrites the session's own unread news.
 */
import { useMemo } from "react";
import { useLiveQuery, eq } from "@tanstack/react-db";
import {
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
  type AgentPermissionRequestRow,
  type AgentTaskRow,
  type AgentTurn,
} from "@/entities/agents";
import { promptRoundsCollection, type PromptRoundRow } from "@/entities/prompt-rounds";
import { lastSeenAt, useSeen, type SeenTarget } from "@/entities/seen";
import { useOpenWorkspaces } from "@/entities/workspaces";
import { onAppEvent, type AppEvents } from "@/utils/app-events";
import { workspaceKey } from "@/utils/path";

export type AttentionKind = "bau" | "error";
/** A question the agent is blocked on; answered where the item jumps to. */
export type AttentionAsk = "permission" | "auth";

export interface AttentionItem {
  target: SeenTarget;
  kind: AttentionKind;
  taskId: string;
  turnId: string | null;
  since: number;
  workspaceKey: string;
  ask?: AttentionAsk;
  /** The head of the task's pending permission queue (ask "permission"). */
  permission?: AgentPermissionRequestRow;
  /** The task row, for what an ask says about itself. */
  task?: AgentTaskRow;
}

export interface Attention {
  items: AttentionItem[];
  /** The questions, for the one card that lists them. */
  asks: AttentionItem[];
  byTask: ReadonlyMap<string, AttentionKind>;
  byRound: ReadonlyMap<string, AttentionKind>;
  /** The most pressing kind over everything — the sidebar's one dot. A
   *  list that shows only some rows marks its title from those rows
   *  (`mostPressing` over what it renders), never from here. */
  overall: AttentionKind | null;
  /** Per workspaceKey: items of kind "error" — the rail's badge. */
  byWorkspace: ReadonlyMap<string, number>;
}

function isWorking(task: AgentTaskRow): boolean {
  return task.status === "running" || task.status === "starting";
}

/**
 * The listener's body, exported for tests: a settle with no prompt round
 * behind it is the session's news, and outlives the turn row on the task
 * row. A widget round's settle is the round's (prompt-rounds.ts records
 * it); a cancel was the user's own doing and says nothing.
 */
export async function recordSessionSettled(
  detail: AppEvents["agent:turn-settled"],
): Promise<void> {
  if (detail.status === "cancelled") return;
  await Promise.all([promptRoundsCollection.preload(), agentTasksCollection.preload()]);
  if (promptRoundsCollection.get(detail.turnId)) return;
  if (!agentTasksCollection.get(detail.taskId)) return;
  const lastSettled = { turnId: detail.turnId, at: detail.at, status: detail.status };
  await agentTasksCollection.update(detail.taskId, (draft) => {
    draft.lastSettled = lastSettled;
  }).isPersisted.promise;
}

/** Boot: the one global listener. Returns the unsubscribe. */
export function startAttentionTracking(): () => void {
  return onAppEvent("agent:turn-settled", (detail) => {
    void recordSessionSettled(detail).catch((error) => {
      console.error("Failed to record a session's settled turn:", error);
    });
  });
}

/** error outranks bau. */
export function mostPressing(
  a: AttentionKind | null,
  b: AttentionKind | null,
): AttentionKind | null {
  if (a === "error" || b === "error") return "error";
  return a ?? b;
}

/** Pending permission requests per task, oldest first (ids sort chronological). */
function headPermissionByTask(
  pending: AgentPermissionRequestRow[],
): Map<string, AgentPermissionRequestRow> {
  const heads = new Map<string, AgentPermissionRequestRow>();
  const sorted = pending
    .filter((request) => request.status === "pending")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const request of sorted) {
    if (!heads.has(request.taskId)) heads.set(request.taskId, request);
  }
  return heads;
}

/** What a task is blocked on, if anything: answered where the item jumps to. */
function askOf(
  task: AgentTaskRow,
  permission: AgentPermissionRequestRow | undefined,
): Pick<AttentionItem, "ask" | "permission"> | null {
  if (permission) return { ask: "permission", permission };
  if (task.authRequired) return { ask: "auth" };
  return null;
}

/**
 * An error or absence no turn produced — a harness that never came up, a
 * load failure, a process that died while idle. A turn's own failure is
 * the settle instead: its status is "error" too.
 */
function isErrorNoTurnProduced(task: AgentTaskRow): boolean {
  return (
    task.status === "unavailable" ||
    (task.status === "error" && task.lastSettled?.status !== "error")
  );
}

/** The last settle, when it is news for this session. */
function settledTurnAttention(
  task: AgentTaskRow,
  settled: NonNullable<AgentTaskRow["lastSettled"]>,
  lastLooked: number,
): Pick<AttentionItem, "kind" | "turnId" | "since"> | null {
  if (settled.at <= lastLooked) return null;
  // A finished turn on a session that has since started another is not
  // news: the session has moved on, and the new turn re-marks it when it
  // settles. (A failure still stands — it is what the new turn follows.)
  if (settled.status === "completed" && isWorking(task)) return null;
  return {
    kind: settled.status === "error" ? "error" : "bau",
    turnId: settled.turnId,
    since: settled.at,
  };
}

function taskAttention(
  task: AgentTaskRow,
  permission: AgentPermissionRequestRow | undefined,
  runningTurnId: string | null,
  seen: ReadonlyMap<string, number>,
): AttentionItem | null {
  const target: SeenTarget = { kind: "task", id: task.taskId };
  const base = {
    target,
    taskId: task.taskId,
    // The turn in flight when the item was raised — what a jump prefers
    // when the task has several widgets bound to it.
    turnId: runningTurnId,
    since: task.updatedAt,
    workspaceKey: workspaceKey(task.workspacePath),
    task,
  };
  // Asks clear when answered, not when looked at: the run is blocked on it.
  const ask = askOf(task, permission);
  if (ask) return { ...base, kind: "error", ...ask };

  const lastLooked = lastSeenAt(seen, target);
  // Its moment is the row's last transition (`updatedAt`, bumped on the way
  // into the status), and the comparison is the same as a turn's: newer
  // than the last look it is marked; looked at, it clears; failing again
  // re-marks it.
  if (isErrorNoTurnProduced(task)) {
    return task.updatedAt > lastLooked ? { ...base, kind: "error" } : null;
  }
  if (!task.lastSettled) return null;
  const settled = settledTurnAttention(task, task.lastSettled, lastLooked);
  return settled ? { ...base, ...settled } : null;
}

function roundAttention(
  round: PromptRoundRow,
  seen: ReadonlyMap<string, number>,
): AttentionItem | null {
  if (round.status !== "completed" && round.status !== "error") return null;
  if (round.settledAt === undefined) return null;
  const target: SeenTarget = { kind: "document", id: round.documentPath };
  if (round.settledAt <= lastSeenAt(seen, target)) return null;
  return {
    target,
    kind: round.status === "error" ? "error" : "bau",
    taskId: round.taskId,
    turnId: round.turnId,
    since: round.settledAt,
    workspaceKey: round.workspaceKey,
  };
}

/** The attention model as a pure function of the rows — exported for tests. */
export function deriveAttention(rows: {
  tasks: AgentTaskRow[];
  rounds: PromptRoundRow[];
  runningTurns: Pick<AgentTurn, "taskId" | "turnId">[];
  openWorkspaceKeys: ReadonlySet<string>;
  pendingPermissions: AgentPermissionRequestRow[];
  seen: ReadonlyMap<string, number>;
}): Attention {
  const heads = headPermissionByTask(rows.pendingPermissions);
  const runningByTask = new Map(rows.runningTurns.map((t) => [t.taskId, t.turnId]));

  const items: AttentionItem[] = [];
  const byTask = new Map<string, AttentionKind>();
  const byRound = new Map<string, AttentionKind>();
  const byWorkspace = new Map<string, number>();
  let overall: AttentionKind | null = null;

  for (const task of rows.tasks) {
    const item = taskAttention(
      task,
      heads.get(task.taskId),
      runningByTask.get(task.taskId) ?? null,
      rows.seen,
    );
    if (!item) continue;
    items.push(item);
    byTask.set(task.taskId, item.kind);
  }
  for (const round of rows.rounds) {
    if (!rows.openWorkspaceKeys.has(round.workspaceKey)) continue;
    const item = roundAttention(round, rows.seen);
    if (!item) continue;
    items.push(item);
    byRound.set(round.turnId, item.kind);
  }
  for (const item of items) {
    overall = mostPressing(overall, item.kind);
    if (item.kind !== "error") continue;
    byWorkspace.set(item.workspaceKey, (byWorkspace.get(item.workspaceKey) ?? 0) + 1);
  }
  items.sort((a, b) => b.since - a.since);

  return {
    items,
    asks: items.filter((item) => item.ask !== undefined),
    byTask,
    byRound,
    overall,
    byWorkspace,
  };
}

/** Live `deriveAttention` over the collections. */
export function useAttention(): Attention {
  const { data: tasks = [] } = useLiveQuery((q) =>
    q.from({ task: agentTasksCollection }),
  );
  const { data: rounds = [] } = useLiveQuery((q) =>
    q.from({ round: promptRoundsCollection }),
  );
  const { data: runningTurns = [] } = useLiveQuery((q) =>
    q
      .from({ turn: agentTurnsCollection })
      .where(({ turn }) => eq(turn.status, "running")),
  );
  const { data: pendingPermissions = [] } = useLiveQuery((q) =>
    q
      .from({ req: agentPermissionRequestsCollection })
      .where(({ req }) => eq(req.status, "pending")),
  );
  const openWorkspaces = useOpenWorkspaces();
  const seen = useSeen();
  return useMemo(
    () =>
      deriveAttention({
        tasks,
        rounds,
        runningTurns,
        openWorkspaceKeys: new Set(openWorkspaces.map((row) => row.key)),
        pendingPermissions,
        seen,
      }),
    [tasks, rounds, runningTurns, openWorkspaces, pendingPermissions, seen],
  );
}
