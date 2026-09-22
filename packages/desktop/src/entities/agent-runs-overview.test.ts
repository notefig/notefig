import { describe, expect, it } from "vitest";
import type {
  AgentPermissionRequestRow,
  AgentTaskRow,
  AgentTurn,
} from "@/agent/agent-collections";
import { deriveAgentRunsOverview } from "./agents";

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

function turn(
  overrides: Partial<AgentTurn> & Pick<AgentTurn, "turnId" | "taskId">,
): AgentTurn {
  return { sessionId: "s", status: "running", startedAt: 1, ...overrides };
}

function permission(
  id: string,
  taskId: string,
  status: AgentPermissionRequestRow["status"] = "pending",
): AgentPermissionRequestRow {
  return { id, taskId, sessionId: "s", title: `allow ${id}`, options: [], status };
}

const EMPTY = { runningTurns: [], queuedTurns: [], pendingPermissions: [] };

describe("deriveAgentRunsOverview", () => {
  it("is empty with nothing to show", () => {
    const overview = deriveAgentRunsOverview({ tasks: [], ...EMPTY });
    expect(overview.attention).toEqual([]);
    expect(overview.working).toEqual([]);
    expect(overview.byWorkspace.size).toBe(0);
  });

  it("names each task's most pressing kind, listed by last activity", () => {
    const tasks = [
      // A pending permission outranks the auth flag on the same task.
      task({ taskId: "task_perm", status: "running", authRequired: true, updatedAt: 5 }),
      task({ taskId: "task_auth", status: "idle", authRequired: true, updatedAt: 4 }),
      task({ taskId: "task_gone", status: "unavailable", updatedAt: 3 }),
      task({ taskId: "task_err", status: "error", updatedAt: 2 }),
      // A settled request is not attention.
      task({ taskId: "task_ok", status: "idle", updatedAt: 9 }),
    ];
    const overview = deriveAgentRunsOverview({
      tasks,
      ...EMPTY,
      pendingPermissions: [
        permission("task_perm_perm_2", "task_perm"),
        permission("task_perm_perm_1", "task_perm"),
        permission("task_ok_perm_1", "task_ok", "granted"),
      ],
    });
    expect(
      overview.attention.map((item) => [item.task.taskId, item.kind]),
    ).toEqual([
      ["task_perm", "permission"],
      ["task_auth", "auth"],
      ["task_gone", "unavailable"],
      ["task_err", "error"],
    ]);
    // The head of the queue is the oldest pending request.
    expect(overview.attention[0].permission?.id).toBe("task_perm_perm_1");
  });

  it("carries the running turn so a jump lands on the raising round", () => {
    const overview = deriveAgentRunsOverview({
      tasks: [task({ taskId: "task_a", status: "running" })],
      ...EMPTY,
      runningTurns: [turn({ turnId: "trn_9", taskId: "task_a" })],
      pendingPermissions: [permission("task_a_perm_1", "task_a")],
    });
    expect(overview.attention[0].turnId).toBe("trn_9");
    // Running AND waiting: counted in both lists.
    expect(overview.working.map((meta) => meta.task.taskId)).toEqual(["task_a"]);
  });

  it("lists working tasks by last activity with their queue depth", () => {
    const overview = deriveAgentRunsOverview({
      tasks: [
        task({ taskId: "task_old", status: "running", updatedAt: 1 }),
        task({ taskId: "task_new", status: "starting", updatedAt: 5 }),
        task({ taskId: "task_idle", status: "idle", updatedAt: 9 }),
      ],
      ...EMPTY,
      queuedTurns: [
        turn({ turnId: "trn_1", taskId: "task_old", status: "queued" }),
        turn({ turnId: "trn_2", taskId: "task_old", status: "queued" }),
      ],
    });
    expect(
      overview.working.map((meta) => [meta.task.taskId, meta.queuedCount]),
    ).toEqual([
      ["task_new", 0],
      ["task_old", 2],
    ]);
  });

  it("counts per workspace key, collapsing respellings", () => {
    const overview = deriveAgentRunsOverview({
      tasks: [
        task({ taskId: "task_1", workspacePath: "/ws-a", status: "running" }),
        task({ taskId: "task_2", workspacePath: "/ws-a/", status: "error" }),
        task({ taskId: "task_3", workspacePath: "/ws-b", status: "running" }),
      ],
      ...EMPTY,
    });
    expect([...overview.byWorkspace.entries()]).toEqual([
      ["/ws-a", { attention: 1, working: 1 }],
      ["/ws-b", { attention: 0, working: 1 }],
    ]);
  });
});
