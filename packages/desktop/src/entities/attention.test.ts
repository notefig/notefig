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
  openWorkspaceKeys: new Set(["/ws-a"]),
  pendingPermissions: [],
  seen: seenAt([]),
};

describe("deriveAttention", () => {
  it("is empty with nothing to show", () => {
    const attention = deriveAttention(EMPTY);
    expect(attention.items).toEqual([]);
    expect(attention.sections).toEqual({ prompts: null, sessions: null });
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
    expect(unseen.sections.sessions).toBe("error");

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

  it("a widget round marks its document, never its session", () => {
    const tasks = [
      task({ taskId: "task_w", lastSettled: { turnId: "t_w", at: 10, status: "completed" } }),
    ];
    const rounds = [round({ turnId: "t_w" })];
    const attention = deriveAttention({ ...EMPTY, tasks, rounds });
    expect(attention.byTask.has("task_w")).toBe(false);
    expect(attention.byRound.get("t_w")).toBe("bau");
    expect(attention.sections).toEqual({ prompts: "bau", sessions: null });
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
    expect(attention.sections.prompts).toBe("error");
  });

  it("cancelled and still-live rounds, and rounds of closed workspaces, say nothing", () => {
    const rounds = [
      round({ turnId: "t_cancel", status: "cancelled" }),
      round({ turnId: "t_live", status: "live", settledAt: undefined }),
      round({ turnId: "t_closed", workspaceKey: "/ws-closed" }),
    ];
    expect(deriveAttention({ ...EMPTY, rounds }).items).toEqual([]);
  });

  it("asks and absences are errors that looking does not clear", () => {
    const tasks = [
      task({ taskId: "task_perm", status: "running" }),
      task({ taskId: "task_auth", authRequired: true }),
      task({ taskId: "task_gone", status: "unavailable" }),
      task({ taskId: "task_spawn", status: "error" }),
    ];
    const attention = deriveAttention({
      ...EMPTY,
      tasks,
      pendingPermissions: [permission("p2", "task_perm"), permission("p1", "task_perm")],
      seen: seenAt(tasks.map((t) => [seenKey({ kind: "task", id: t.taskId }), 1_000])),
    });
    expect([...attention.byTask.values()]).toEqual(["error", "error", "error", "error"]);
    // Only the questions make the card; the oldest request is the one asked.
    expect(attention.asks.map((item) => [item.taskId, item.ask])).toEqual([
      ["task_perm", "permission"],
      ["task_auth", "auth"],
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
    expect(attention.sections).toEqual({ prompts: "error", sessions: "bau" });
    expect(attention.overall).toBe("error");
  });

  it("counts errors per workspace key for the rail, newest first overall", () => {
    const attention = deriveAttention({
      ...EMPTY,
      openWorkspaceKeys: new Set(["/ws-a", "/ws-b"]),
      tasks: [
        task({ taskId: "task_a", workspacePath: "/ws-a", status: "unavailable", updatedAt: 3 }),
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
