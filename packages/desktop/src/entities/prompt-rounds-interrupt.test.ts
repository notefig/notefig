/**
 * Interrupting a round settles it (MET-208) — end to end, because the defect
 * lived in the seam: the service deleted a turn row without announcing the
 * settle, and the sidebar's derivation read that absence as "running".
 *
 * Drives the real AgentTask against a FakeAgent with the real prompt-round
 * listener attached, through every interrupt the prompt widget offers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: {
      writeFiles: vi.fn(async (files: { path: string }[]) => ({
        succeeded: files.map((f) => f.path),
        failed: [],
      })),
      readFiles: vi.fn(async (paths: string[]) => ({
        succeeded: paths.map((p) => ({ path: p, content: "" })),
        failed: [],
      })),
      deleteFiles: vi.fn(async (paths: string[]) => ({
        succeeded: paths,
        failed: [],
      })),
    },
    proc: {
      createMcpEndpoint: vi.fn(() => ({
        mcpServer: { name: "notefig", command: "notefig", args: [], env: [] },
        start: vi.fn(async () => {}),
        onRequest: vi.fn(() => () => {}),
        close: vi.fn(async () => {}),
      })),
    },
  },
}));
vi.mock("@/utils/history-service", () => ({
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/entities/workspaces", () => ({ useOpenWorkspaces: () => [] }));

import { createLoopbackPair } from "@notefig/agent";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { FakeAgent } from "@/agent/mock-harness";
import { TaskManager, type AgentTask } from "@/agent/agent-service";
import { agentTurnsCollection } from "@/agent/agent-collections";
import { emitAppEvent } from "@/utils/app-events";
import {
  derivePromptRounds,
  promptRoundsCollection,
  startPromptRoundTracking,
} from "@/entities/prompt-rounds";
import { workspaceKey } from "@/utils/path";

const harness = BUILT_IN_HARNESSES[0];
const open = [{ key: workspaceKey("/ws"), path: "/ws" }];

/** What the sidebar would show for this round right now. */
function shownStatus(turnId: string): string | undefined {
  return derivePromptRounds(
    [...promptRoundsCollection.values()],
    open,
    [...agentTurnsCollection.values()],
  ).find((round) => round.turnId === turnId)?.status;
}

/** Send through the widget host's path: prompt + the round-started event. */
function sendRound(task: AgentTask, text: string): string {
  const { turnId } = task.prompt(text);
  emitAppEvent("widget:round-started", {
    taskId: task.taskId,
    turnId,
    workspacePath: "/ws",
    documentPath: "/ws/doc.md",
    prompt: text,
  });
  return turnId;
}

async function startedTask(agent: FakeAgent, client: unknown) {
  const task = new TaskManager("/ws").createTask(harness);
  await task.start(() => client as never);
  void agent;
  return task;
}

describe("interrupted prompt rounds", () => {
  let stop: () => void;

  beforeEach(async () => {
    await promptRoundsCollection.preload();
    const keys = [...promptRoundsCollection.keys()];
    if (keys.length > 0)
      await promptRoundsCollection.delete(keys).isPersisted.promise;
    for (const turn of agentTurnsCollection.toArray)
      agentTurnsCollection.delete(turn.turnId);
    stop?.();
    stop = startPromptRoundTracking();
  });

  it("Stop while running settles the round", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working" },
      });
      await gate;
      return { stopReason: "cancelled" };
    };
    const task = await startedTask(agent, client);

    const turnId = sendRound(task, "do the thing");
    await vi.waitFor(() =>
      expect(promptRoundsCollection.get(turnId)).toBeDefined(),
    );
    await task.cancel(); // the widget's Stop button
    release();

    await vi.waitFor(() => expect(shownStatus(turnId)).not.toBe("running"));
    expect(shownStatus(turnId)).toBe("cancelled");
  });

  it("Escape-to-restore while running settles the round", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    agent.onPrompt = async () => {
      await gate; // no response yet — the forgettable case
      return { stopReason: "cancelled" };
    };
    const task = await startedTask(agent, client);

    const turnId = sendRound(task, "doomed");
    await vi.waitFor(() =>
      expect(promptRoundsCollection.get(turnId)).toBeDefined(),
    );
    await expect(task.cancelAndForgetTurn()).resolves.toBe(true);
    release();

    await vi.waitFor(() => expect(shownStatus(turnId)).not.toBe("running"));
  });

  it("dismissing a queued prompt settles the round", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let count = 0;
    agent.onPrompt = async () => {
      if (count++ === 0) await gate;
      return { stopReason: "end_turn" };
    };
    const task = await startedTask(agent, client);

    sendRound(task, "first");
    const queuedId = sendRound(task, "queued one");
    await vi.waitFor(() =>
      expect(promptRoundsCollection.get(queuedId)).toBeDefined(),
    );
    expect(shownStatus(queuedId)).toBe("queued");

    task.removeQueuedPrompt(queuedId); // the widget's ✕ / Edit
    release();

    await vi.waitFor(() => expect(shownStatus(queuedId)).not.toBe("running"));
  });
});
