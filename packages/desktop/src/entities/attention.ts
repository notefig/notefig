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
 *    turn clears when looked at; a session that is *asking* (permission,
 *    sign-in) or has gone (unavailable) clears when the condition does.
 *
 * A widget round lands on its document, never on its session: the widget
 * is where the user is pointed, so the session stays quiet.
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

function taskAttention(
  task: AgentTaskRow,
  permission: AgentPermissionRequestRow | undefined,
  runningTurnId: string | null,
  isWidgetRound: (turnId: string) => boolean,
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
  // Asks and absences clear when the condition clears, not when looked at.
  if (permission) {
    return { ...base, kind: "error", ask: "permission", permission };
  }
  if (task.authRequired) return { ...base, kind: "error", ask: "auth" };
  if (task.status === "unavailable") return { ...base, kind: "error" };

  const settled = task.lastSettled;
  // An error that no turn produced — a spawn or load failure, a process
  // that died while idle — has no settle to be seen; it stands until the
  // task recovers. (A turn's own failure is the settle below: its status
  // is "error" too, and looking at it is what clears it.)
  if (task.status === "error" && settled?.status !== "error") {
    return { ...base, kind: "error" };
  }
  if (!settled) return null;
  // A widget round's result is in its document; the session stays quiet.
  if (isWidgetRound(settled.turnId)) return null;
  if (settled.at <= lastSeenAt(seen, target)) return null;
  return {
    ...base,
    kind: settled.status === "error" ? "error" : "bau",
    turnId: settled.turnId,
    since: settled.at,
  };
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
  const roundTurnIds = new Set(rows.rounds.map((round) => round.turnId));
  const isWidgetRound = (turnId: string) => roundTurnIds.has(turnId);

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
      isWidgetRound,
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
