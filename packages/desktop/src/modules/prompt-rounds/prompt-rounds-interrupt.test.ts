/**
 * Interrupting a round settles it (MET-208) — end to end, because the defect
 * lived in the seam: the service deleted a turn row without announcing the
 * settle, and the sidebar's derivation read that absence as "running".
 *
 * Drives the real AgentTask against a FakeAgent with the real prompt-round
 * listener attached, through every interrupt the prompt widget offers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createLoopbackPair } from "@notefig/agent";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { FakeAgent } from "@/modules/agents/mock-harness";
import { TaskManager, type AgentTask } from "@/modules/agents/agent-service";
import {
  createPromptRounds,
  derivePromptRounds,
  type PromptRoundsApi,
} from "@/modules/prompt-rounds";
import { createNodeTestDb } from "@/testing/node-db";
import { testAgents, type TestAgents } from "@/testing/test-agents";
import { workspaceKey } from "@/utils/path";

const harness = BUILT_IN_HARNESSES[0];
const open = [{ key: workspaceKey("/ws"), path: "/ws" }];

let agentLayer: TestAgents;
let rounds: PromptRoundsApi;

/** What the sidebar would show for this round right now. */
function shownStatus(turnId: string): string | undefined {
  return derivePromptRounds(
    [...rounds.collection.values()],
    open,
    [...agentLayer.store.turns.values()],
  ).find((round) => round.turnId === turnId)?.status;
}

/** Send through the widget host's path: prompt + the round-started event. */
function sendRound(task: AgentTask, text: string): string {
  const { turnId } = task.prompt(text);
  agentLayer.hooks.emit("widget:round-started", {
    taskId: task.taskId,
    turnId,
    workspacePath: "/ws",
    documentPath: "/ws/doc.md",
    prompt: text,
  });
  return turnId;
}

async function startedTask(agent: FakeAgent, client: unknown) {
  const task = new TaskManager(agentLayer.deps, "/ws").createTask(harness);
  await task.start(() => client as never);
  void agent;
  return task;
}

describe("interrupted prompt rounds", () => {
  let stop: () => void;

  beforeEach(() => {
    // The rounds read the turn rows of the same store the tasks write.
    agentLayer = testAgents();
    rounds = createPromptRounds({
      persistence: createNodeTestDb().get(),
      turns: agentLayer.store.turns,
      hooks: agentLayer.hooks,
    });
    stop?.();
    stop = rounds.track();
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
      expect(rounds.collection.get(turnId)).toBeDefined(),
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
      expect(rounds.collection.get(turnId)).toBeDefined(),
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
      expect(rounds.collection.get(queuedId)).toBeDefined(),
    );
    expect(shownStatus(queuedId)).toBe("queued");

    task.removeQueuedPrompt(queuedId); // the widget's ✕ / Edit
    release();

    await vi.waitFor(() => expect(shownStatus(queuedId)).not.toBe("running"));
  });
});
