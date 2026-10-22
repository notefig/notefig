/**
 * The prompt widgets over the app's agent store: each widget's state
 * follows its round's rows as the agent service writes them.
 */
import { describe, expect, it } from "vitest";
import { createPromptWidgets } from "@notefig/widgets";
import type { AgentTurn } from "@/modules/agents/agent-collections";
import { testAgentStore } from "@/testing/test-agents";
import { roundObserverFor } from "./prompt-widgets";

function turn(status: AgentTurn["status"]): AgentTurn {
  return {
    turnId: "trn_1",
    taskId: "task_1",
    sessionId: "sess_1",
    status,
    startedAt: 0,
  };
}

async function sentWidget() {
  const store = testAgentStore();
  const prompts = createPromptWidgets({ observeRound: roundObserverFor(store) });
  await prompts.send("blob", "summarize", async () => {
    store.turns.insert(turn("queued"));
    return { taskId: "task_1", turnId: "trn_1" };
  });
  return { store, prompts };
}

describe("promptWidgets over the agent store", () => {
  it("follows the bound turn through its statuses", async () => {
    const { store, prompts } = await sentWidget();
    expect(prompts.get("blob").state).toEqual({ name: "working", turn: "queued" });

    store.turns.update("trn_1", (draft) => {
      draft.status = "running";
    });
    expect(prompts.get("blob").state).toEqual({ name: "working", turn: "running" });

    store.permissionRequests.insert({
      id: "perm_1",
      taskId: "task_1",
      sessionId: "sess_1",
      title: "Edit notes.md",
      options: [],
      status: "pending",
    });
    expect(prompts.get("blob").state).toEqual({
      name: "asking",
      ask: { kind: "permission" },
    });

    store.permissionRequests.update("perm_1", (draft) => {
      draft.status = "granted";
    });
    store.turns.update("trn_1", (draft) => {
      draft.status = "completed";
    });
    expect(prompts.get("blob").state).toEqual({ name: "settled", outcome: "done" });
  });

  it("drops the turn, keeping the session, when the turn's row is deleted", async () => {
    // What a session revival's replay does to every earlier turn.
    const { store, prompts } = await sentWidget();
    store.turns.delete("trn_1");
    expect(prompts.get("blob")).toMatchObject({
      state: { name: "composing" },
      boundTurnId: null,
      boundTaskId: "task_1",
    });
  });
});
