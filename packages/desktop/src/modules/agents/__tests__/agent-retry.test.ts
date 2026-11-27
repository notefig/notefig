import { describe, it, expect, beforeEach } from "vitest";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { createMockAgentTransport, mockPrompts } from "../mock-harness";
import type { AgentRuntime } from "../agent-service";
import { createAgentStore, type AgentStore } from "../agent-collections";
import { createNodeTestDb } from "@/testing/node-db";
import { fakeMcpEndpoint, testAgents } from "@/testing/test-agents";

// A failed turn, retried, and a session whose agent exited — against the
// mock harness's own misbehaviours (`/error`, `/flaky`, `/crash`…), each
// spawn a fresh scripted agent as a respawned adapter is a new process.

let store: AgentStore;
let runtime: AgentRuntime;
/** How many agent processes were spawned. */
let spawns: number;

beforeEach(async () => {
  store = createAgentStore(createNodeTestDb().get());
  spawns = 0;
  let deps;
  ({ runtime, deps } = testAgents({
    store,
    proc: {
      createMcpEndpoint: () => fakeMcpEndpoint(),
      createAgentTransport: ({ taskId }) => {
        spawns++;
        return createMockAgentTransport({ taskId });
      },
    },
  }));
  await store.tasks.preload();
  await deps.harnesses.ready();
});

async function startSession() {
  const { taskId, started } = runtime.start("/ws", BUILT_IN_HARNESSES[0]);
  await started;
  return taskId;
}

/** What one turn of the session went out as: the prompts the agent got
 *  for it, from the log every test shares (counted from `since`). */
function sentSince(since: number) {
  return mockPrompts().slice(since);
}

function userEntries(taskId: string) {
  return store.entriesForTask(taskId).filter((entry) => entry.type === "user");
}

/** Resolves when the turn's row reaches one of `statuses`. */
async function settled(turnId: string, statuses = ["completed", "error"]) {
  await expect
    .poll(() => store.turns.get(turnId)?.status, { timeout: 3000 })
    .toSatisfy((status: string | undefined) => statuses.includes(status ?? ""));
  return store.turns.get(turnId)!;
}

describe("retrying a failed turn", () => {
  it("sends the same prompt again on the same session, under the same rows", async () => {
    const taskId = await startSession();
    const since = mockPrompts().length;
    const { turnId, completed } = runtime.task(taskId)!.prompt("/flaky 1 hello");
    expect(await completed).toMatchObject({ status: "error" });

    expect(runtime.retryTurn(taskId, turnId)).toBe(true);
    const turn = await settled(turnId, ["completed"]);
    expect(turn.error).toBeUndefined();

    const sent = sentSince(since);
    expect(sent.map((p) => p.text)).toEqual(["/flaky 1 hello", "/flaky 1 hello"]);
    expect(new Set(sent.map((p) => p.sessionId)).size).toBe(1);
    expect(userEntries(taskId)).toHaveLength(1);
    expect(spawns).toBe(1);
  });

  it("fails again, and again retries, while the agent keeps failing", async () => {
    const taskId = await startSession();
    const { turnId, completed } = runtime.task(taskId)!.prompt("/flaky 2");
    await completed;
    expect(runtime.retryTurn(taskId, turnId)).toBe(true);
    expect((await settled(turnId, ["error"])).error).toMatch(/attempt 2 of 3/);
    expect(runtime.retryTurn(taskId, turnId)).toBe(true);
    await settled(turnId, ["completed"]);
  });

  it("runs a sign-in retry sent the moment the failure lands", async () => {
    const taskId = await startSession();
    const { turnId, completed } = runtime.task(taskId)!.prompt("/auth");
    await completed;
    expect(store.tasks.get(taskId)?.authRequired).toBe(true);
    expect(runtime.retryTurn(taskId, turnId)).toBe(true);
    await settled(turnId, ["completed"]);
  });

  it("refuses a turn that didn't fail", async () => {
    const taskId = await startSession();
    const { turnId, completed } = runtime.task(taskId)!.prompt("hello");
    await completed;
    expect(runtime.retryTurn(taskId, turnId)).toBe(false);
  });
});

describe("a session whose agent exited", () => {
  it("restarts for the retry: session/load on the same session, then the prompt again", async () => {
    const taskId = await startSession();
    const sessionId = store.tasks.get(taskId)!.sessionId;
    const since = mockPrompts().length;
    const { turnId, completed } = runtime.task(taskId)!.prompt("/crash");
    expect(await completed).toMatchObject({
      status: "error",
      error: "agent process exited (code 1)",
    });
    expect(runtime.task(taskId)!.exited).toBe(true);

    expect(runtime.retryTurn(taskId, turnId)).toBe(true);
    await settled(turnId, ["completed"]);

    expect(spawns).toBe(2);
    expect(store.tasks.get(taskId)).toMatchObject({ sessionId, status: "idle" });
    expect(sentSince(since)).toEqual([
      { sessionId, text: "/crash" },
      { sessionId, text: "/crash" },
    ]);
    // The history's copy of the crashed attempt gives way to the retried turn.
    expect(userEntries(taskId).map((entry) => entry.text)).toEqual(["/crash"]);
  });

  it("restarts for the next prompt after it exited while idle", async () => {
    const taskId = await startSession();
    const sessionId = store.tasks.get(taskId)!.sessionId;
    await runtime.task(taskId)!.prompt("/crash-idle").completed;
    await expect.poll(() => runtime.task(taskId)?.exited).toBe(true);

    const outcome = await runtime.getOrRevive(taskId)!.prompt("still there?").completed;
    expect(outcome).toMatchObject({ status: "completed" });
    expect(mockPrompts().at(-1)).toEqual({ sessionId, text: "still there?" });
  });

  it("takes the prompts queued behind the crashed turn along, in order", async () => {
    const taskId = await startSession();
    const task = runtime.task(taskId)!;
    const crashed = task.prompt("/crash");
    const behind = task.prompt("after the crash");
    await crashed.completed;

    expect(runtime.retryTurn(taskId, crashed.turnId)).toBe(true);
    expect(await behind.completed).toMatchObject({ status: "completed" });
    expect(store.turns.get(crashed.turnId)?.status).toBe("completed");
    expect(mockPrompts().slice(-2).map((p) => p.text)).toEqual(["/crash", "after the crash"]);
  });

  it("can't retry once the harness lost the session: the row says so", async () => {
    const taskId = await startSession();
    await runtime.task(taskId)!.prompt("/evict").completed;
    const { turnId, completed } = runtime.task(taskId)!.prompt("/crash");
    await completed;

    expect(runtime.retryTurn(taskId, turnId)).toBe(true);
    await settled(turnId, ["error"]);
    await expect.poll(() => store.tasks.get(taskId)?.status).toBe("unavailable");
    expect(runtime.retryTurn(taskId, turnId)).toBe(false);
  });
});

describe("a restart while the harness rows still load", () => {
  it("keeps the retried turn and the prompts behind it, in order", async () => {
    // A runtime of its own whose harness rows haven't loaded: revival waits.
    store = createAgentStore(createNodeTestDb().get());
    ({ runtime } = testAgents({
      store,
      proc: {
        createMcpEndpoint: () => fakeMcpEndpoint(),
        createAgentTransport: ({ taskId }) => createMockAgentTransport({ taskId }),
      },
    }));
    await store.tasks.preload();
    const { taskId, started } = runtime.start("/ws", BUILT_IN_HARNESSES[0]);
    await started;
    const task = runtime.task(taskId)!;
    const crashed = task.prompt("/crash");
    const behind = task.prompt("after the crash");
    await crashed.completed;

    expect(runtime.retryTurn(taskId, crashed.turnId)).toBe(true);
    expect(await behind.completed).toMatchObject({ status: "completed" });
    expect(store.turns.get(crashed.turnId)?.status).toBe("completed");
    expect(mockPrompts().slice(-2).map((p) => p.text)).toEqual(["/crash", "after the crash"]);
  });
});

describe("the runtime a restart replaces", () => {
  it("has closed before the new one opens anything: they share the taskId", async () => {
    store = createAgentStore(createNodeTestDb().get());
    let openClose = () => {};
    const closing = new Promise<void>((resolve) => (openClose = resolve));
    let endpoints = 0;
    let spawned = 0;
    let deps;
    ({ runtime, deps } = testAgents({
      store,
      proc: {
        createMcpEndpoint: () => {
          endpoints++;
          // The first runtime's endpoint takes its time to close.
          return { ...fakeMcpEndpoint(), close: () => (endpoints === 1 ? closing : Promise.resolve()) };
        },
        createAgentTransport: ({ taskId }) => {
          spawned++;
          return createMockAgentTransport({ taskId });
        },
      },
    }));
    await store.tasks.preload();
    await deps.harnesses.ready();
    const { taskId, started } = runtime.start("/ws", BUILT_IN_HARNESSES[0]);
    await started;
    const { turnId, completed } = runtime.task(taskId)!.prompt("/crash");
    await completed;
    endpoints = 1; // the next close is the first runtime's

    expect(runtime.retryTurn(taskId, turnId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawned).toBe(1);
    expect(store.turns.get(turnId)?.status).toBe("queued");

    openClose();
    await settled(turnId, ["completed"]);
    expect(spawned).toBe(2);
  });
});

describe("a revival that never reached the harness", () => {
  it("leaves the session an error to retry, not unavailable", async () => {
    store = createAgentStore(createNodeTestDb().get());
    let deps;
    ({ runtime, deps } = testAgents({
      store,
      proc: {
        createMcpEndpoint: () => {
          throw new Error("no machine is connected");
        },
        createAgentTransport: ({ taskId }) => createMockAgentTransport({ taskId }),
      },
    }));
    await store.tasks.preload();
    await deps.harnesses.ready();
    store.tasks.insert({
      taskId: "task_saved",
      workspacePath: "/ws",
      title: "saved",
      harnessId: BUILT_IN_HARNESSES[0].id,
      status: "restored",
      sessionId: "sess_saved",
      createdAt: 1,
      updatedAt: 1,
    });
    await runtime.revive("task_saved")!.started.catch(() => {});
    expect(store.tasks.get("task_saved")?.status).toBe("error");
  });
});
