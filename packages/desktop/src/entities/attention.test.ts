import { describe, expect, it } from "vitest";
import type {
  AgentPermissionRequestRow,
  AgentTaskRow,
} from "@/agent/agent-collections";
import type { PromptRoundRow } from "./prompt-rounds";
import { deriveAttention, mostPressing } from "./attention";
import { seenKey } from "./seen";

function task(
  overrides: Partial<AgentTaskRow> & Pick<AgentTaskRow, "taskId">,
): AgentTaskRow {
  return {
    workspacePath: "/ws-a",
    title: overrides.taskId,
    status: "idle",
    harnessId: "claude-code",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function round(
  overrides: Partial<PromptRoundRow> & Pick<PromptRoundRow, "turnId">,
): PromptRoundRow {
  return {
    taskId: "task_w",
    workspaceKey: "/ws-a",
    documentPath: "/ws-a/doc.md",
    prompt: "p",
    status: "completed",
    startedAt: 1,
    settledAt: 10,
    ...overrides,
  };
}

function permission(id: string, taskId: string): AgentPermissionRequestRow {
  return { id, taskId, sessionId: "s", title: `allow ${id}`, options: [], status: "pending" };
}

const seenAt = (entries: [string, number][]) => new Map(entries);
const EMPTY = {
  tasks: [],
  rounds: [],
  runningTurns: [],
  openWorkspaceKeys: new Set(["/ws-a"]),
  pendingPermissions: [],
  seen: seenAt([]),
};

describe("deriveAttention", () => {
  it("is empty with nothing to show", () => {
    const attention = deriveAttention(EMPTY);
    expect(attention.items).toEqual([]);
    expect(attention.overall).toBeNull();
  });

  it("a finished turn is bau, a failed one is error, and looking clears both", () => {
    const tasks = [
      task({ taskId: "task_done", lastSettled: { turnId: "t1", at: 10, status: "completed" } }),
      task({ taskId: "task_bad", status: "error", lastSettled: { turnId: "t2", at: 10, status: "error" } }),
    ];
    const unseen = deriveAttention({ ...EMPTY, tasks });
    expect(unseen.byTask.get("task_done")).toBe("bau");
    expect(unseen.byTask.get("task_bad")).toBe("error");
    expect(unseen.overall).toBe("error");

    const seen = deriveAttention({
      ...EMPTY,
      tasks,
      seen: seenAt([
        [seenKey({ kind: "task", id: "task_done" }), 10],
        [seenKey({ kind: "task", id: "task_bad" }), 11],
      ]),
    });
    expect(seen.items).toEqual([]);
  });

  it("a finished turn is not news once the session has started another", () => {
    // The title and the row must agree: a running session shows its orb,
    // so its stale completion must not mark the section either. A failure
    // is what the new turn follows, and still stands.
    const done = { turnId: "t1", at: 10, status: "completed" as const };
    const failed = { turnId: "t1", at: 10, status: "error" as const };
    const attention = deriveAttention({
      ...EMPTY,
      tasks: [
        task({ taskId: "task_moved_on", status: "running", lastSettled: done }),
        task({ taskId: "task_reviving", status: "starting", lastSettled: done }),
        task({ taskId: "task_retrying", status: "running", lastSettled: failed }),
      ],
    });
    expect([...attention.byTask]).toEqual([["task_retrying", "error"]]);
  });

  it("a new message puts the session back into running; the next settle marks it again", () => {
    // A completes while the user is away; B, sent behind it, runs and
    // completes; the user opens the session. While B runs the session is
    // running — that is the truth the row shows — and B's settle marks the
    // session again. The mark is per session ("something settled here
    // since you looked"), so A is not lost: opening the session shows both.
    const a = { turnId: "tA", at: 10, status: "completed" as const };
    const b = { turnId: "tB", at: 20, status: "completed" as const };
    const looked = seenAt([[seenKey({ kind: "task", id: "task_1" }), 5]]);
    const mark = (t: AgentTaskRow) =>
      deriveAttention({ ...EMPTY, tasks: [t], seen: looked }).byTask.get("task_1") ?? null;

    expect(mark(task({ taskId: "task_1", status: "idle", lastSettled: a }))).toBe("bau");
    expect(mark(task({ taskId: "task_1", status: "running", lastSettled: a }))).toBeNull();
    expect(mark(task({ taskId: "task_1", status: "idle", lastSettled: b }))).toBe("bau");
    // B cancelled by the user leaves A as the last settle, still unread.
    expect(mark(task({ taskId: "task_1", status: "cancelled", lastSettled: a }))).toBe("bau");
    const opened = seenAt([[seenKey({ kind: "task", id: "task_1" }), 25]]);
    expect(
      deriveAttention({ ...EMPTY, tasks: [task({ taskId: "task_1", lastSettled: b })], seen: opened }).items,
    ).toEqual([]);
  });

  it("a widget round marks its document, never its session", () => {
    const tasks = [
      task({ taskId: "task_w", lastSettled: { turnId: "t_w", at: 10, status: "completed" } }),
    ];
    const rounds = [round({ turnId: "t_w" })];
    const attention = deriveAttention({ ...EMPTY, tasks, rounds });
    expect(attention.byTask.has("task_w")).toBe(false);
    expect(attention.byRound.get("t_w")).toBe("bau");
    expect(attention.overall).toBe("bau");
  });

  it("an error no turn produced is marked from the moment it was entered, not from the last turn", () => {
    // A process that died while idle: the task entered error (updatedAt)
    // after its last settle — an old, seen (or widget) completion.
    const tasks = [
      task({ taskId: "task_died", status: "error", updatedAt: 200, lastSettled: { turnId: "t_old", at: 5, status: "completed" } }),
      task({ taskId: "task_widget_died", status: "error", updatedAt: 200, lastSettled: { turnId: "t_w", at: 5, status: "completed" } }),
    ];
    const attention = deriveAttention({
      ...EMPTY,
      tasks,
      rounds: [round({ turnId: "t_w" })],
      seen: seenAt([[seenKey({ kind: "task", id: "task_died" }), 100]]),
    });
    expect(attention.byTask.get("task_died")).toBe("error");
    expect(attention.byTask.get("task_widget_died")).toBe("error");
    // Whereas a turn's own failure is the settle, and looking clears it.
    const turnFailed = deriveAttention({
      ...EMPTY,
      tasks: [task({ taskId: "task_bad", status: "error", lastSettled: { turnId: "t", at: 5, status: "error" } })],
      seen: seenAt([[seenKey({ kind: "task", id: "task_bad" }), 100]]),
    });
    expect(turnFailed.items).toEqual([]);
  });

  it("a round is seen through its document; a later round on the same document is not", () => {
    const rounds = [
      round({ turnId: "t_old", settledAt: 5 }),
      round({ turnId: "t_new", settledAt: 20, status: "error" }),
    ];
    const attention = deriveAttention({
      ...EMPTY,
      rounds,
      seen: seenAt([[seenKey({ kind: "document", id: "/ws-a/doc.md" }), 10]]),
    });
    expect([...attention.byRound]).toEqual([["t_new", "error"]]);
    expect(attention.overall).toBe("error");
  });

  it("cancelled and still-live rounds, and rounds of closed workspaces, say nothing", () => {
    const rounds = [
      round({ turnId: "t_cancel", status: "cancelled" }),
      round({ turnId: "t_live", status: "live", settledAt: undefined }),
      round({ turnId: "t_closed", workspaceKey: "/ws-closed" }),
    ];
    expect(deriveAttention({ ...EMPTY, rounds }).items).toEqual([]);
  });

  it("a harness that never came up is an error that looking clears, and failing again re-marks", () => {
    // A spawn failure (a harness that is not installed) errors the task with
    // no turn behind it. Opening the half-made session is the look that
    // clears it; a later failure enters error again, later than the look.
    const failed = task({ taskId: "task_spawn", status: "error", updatedAt: 50 });
    const gone = task({ taskId: "task_gone", status: "unavailable", updatedAt: 50 });
    const fresh = deriveAttention({ ...EMPTY, tasks: [failed, gone] });
    expect([...fresh.byTask.values()]).toEqual(["error", "error"]);

    const looked = seenAt([
      [seenKey({ kind: "task", id: "task_spawn" }), 60],
      [seenKey({ kind: "task", id: "task_gone" }), 60],
    ]);
    expect(deriveAttention({ ...EMPTY, tasks: [failed, gone], seen: looked }).items).toEqual([]);
    expect(
      deriveAttention({ ...EMPTY, tasks: [{ ...failed, updatedAt: 70 }], seen: looked }).byTask.get("task_spawn"),
    ).toBe("error");
  });

  it("asks are errors that looking does not clear", () => {
    const tasks = [
      task({ taskId: "task_perm", status: "running" }),
      task({ taskId: "task_auth", authRequired: true }),
    ];
    const attention = deriveAttention({
      ...EMPTY,
      tasks,
      runningTurns: [{ taskId: "task_perm", turnId: "t_asking" }],
      pendingPermissions: [permission("p2", "task_perm"), permission("p1", "task_perm")],
      seen: seenAt(tasks.map((t) => [seenKey({ kind: "task", id: t.taskId }), 1_000])),
    });
    expect([...attention.byTask.values()]).toEqual(["error", "error"]);
    // Only the questions make the card; the oldest request is the one asked,
    // and the ask carries the turn that raised it so a jump lands there.
    expect(attention.asks.map((item) => [item.taskId, item.ask, item.turnId])).toEqual([
      ["task_perm", "permission", "t_asking"],
      ["task_auth", "auth", null],
    ]);
    expect(attention.asks[0].permission?.id).toBe("p1");
  });

  it("the sidebar's one dot is amber when anything is an error, else blue", () => {
    expect(mostPressing(null, null)).toBeNull();
    expect(mostPressing("bau", null)).toBe("bau");
    expect(mostPressing("bau", "error")).toBe("error");
    const attention = deriveAttention({
      ...EMPTY,
      tasks: [task({ taskId: "task_done", lastSettled: { turnId: "t1", at: 10, status: "completed" } })],
      rounds: [round({ turnId: "t_bad", status: "error" })],
    });
    expect(attention.byTask.get("task_done")).toBe("bau");
    expect(attention.byRound.get("t_bad")).toBe("error");
    expect(attention.overall).toBe("error");
  });

  it("counts errors per workspace key for the rail, newest first overall", () => {
    const attention = deriveAttention({
      ...EMPTY,
      openWorkspaceKeys: new Set(["/ws-a", "/ws-b"]),
      tasks: [
        task({ taskId: "task_a", workspacePath: "/ws-a", status: "unavailable", updatedAt: 3 }),
        // (unavailable since 3, never looked at: counts)
        task({ taskId: "task_b", workspacePath: "/ws-b/", lastSettled: { turnId: "t", at: 9, status: "completed" } }),
      ],
      rounds: [round({ turnId: "t_b", workspaceKey: "/ws-b", status: "error", settledAt: 7 })],
    });
    expect([...attention.byWorkspace]).toEqual([
      ["/ws-a", 1],
      ["/ws-b", 1],
    ]);
    expect(attention.items.map((item) => item.since)).toEqual([9, 7, 3]);
  });
});
