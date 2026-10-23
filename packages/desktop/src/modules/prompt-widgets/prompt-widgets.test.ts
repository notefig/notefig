/**
 * The prompt widgets over the app's agent store: each widget's state
 * follows its round's rows as the agent service writes them.
 */
import { describe, expect, it } from "vitest";
import { createPromptWidgets } from "@notefig/widgets";
import { createHooks } from "@notefig/core";
import type { AgentEntry, AgentTurn } from "@/modules/agents/agent-collections";
import { createPromptRounds } from "@/modules/prompt-rounds";
import { createNodeTestDb } from "@/testing/node-db";
import { testAgentStore } from "@/testing/test-agents";
import { roundObserverFor, storedRoundObserverFor } from "./prompt-widgets";

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

describe("promptWidgets over stored rounds (MET-251)", () => {
  /** The app's pieces as the modules wire them, over one database. */
  function app(db = createNodeTestDb()) {
    const store = testAgentStore();
    const hooks = createHooks();
    const rounds = createPromptRounds({
      persistence: db.get(),
      turns: store.turns,
      transcript: (turnId) =>
        store.entries.toArray.filter((entry) => entry.turnId === turnId),
      hooks,
    });
    rounds.track();
    const prompts = createPromptWidgets({
      observeRound: roundObserverFor(store),
      observeStoredRound: storedRoundObserverFor(rounds.collection),
    });
    return { db, store, hooks, rounds, prompts };
  }

  /** Send from "blob" and answer, the turn row ending — as the agent
   *  service would — but the round not yet recorded as ended. */
  async function endedTurn(a: ReturnType<typeof app>) {
    await a.prompts.send("blob", "@skill:edit make it shorter", async () => {
      a.store.turns.insert(turn("queued"));
      a.hooks.emit("widget:round-started", {
        taskId: "task_1",
        turnId: "trn_1",
        blobId: "blob",
        workspacePath: "/ws",
        documentPath: "/ws/doc.md",
        prompt: "make it shorter",
        typedPrompt: "@skill:edit make it shorter",
      });
      return { taskId: "task_1", turnId: "trn_1" };
    });
    a.store.entries.insert({
      id: "evt_1",
      turnId: "trn_1",
      taskId: "task_1",
      type: "assistant",
      text: "Shortened it.",
    } as AgentEntry);
    a.store.turns.update("trn_1", (draft) => {
      draft.status = "completed";
    });
  }

  /** …and the round recorded as ended, with what it left. */
  async function settledRound(a: ReturnType<typeof app>) {
    await endedTurn(a);
    await a.rounds.recordSettled({
      taskId: "task_1",
      turnId: "trn_1",
      status: "completed",
      at: Date.now(),
    });
  }

  it("keeps a settled widget's face when a revival replays its turn away", async () => {
    const a = app();
    await settledRound(a);
    expect(a.prompts.get("blob").outcome?.summary).toBe("Shortened it.");
    a.store.turns.delete("trn_1");
    expect(a.prompts.get("blob")).toMatchObject({
      state: { name: "settled", outcome: "done" },
      boundTurnId: "trn_1",
    });
    expect(a.prompts.get("blob").outcome?.summary).toBe("Shortened it.");
  });

  it("brings a widget back as it was left after a restart", async () => {
    const before = app();
    await settledRound(before);
    // A new run over the same database: no turn rows, no widget state.
    const after = app(before.db);
    await after.rounds.collection.preload();
    after.prompts.restore("blob", "task_1");
    expect(after.prompts.get("blob")).toMatchObject({
      state: { name: "settled", outcome: "done" },
      boundTurnId: "trn_1",
      // As typed: Edit and Retry put the directive back.
      lastSentPrompt: "@skill:edit make it shorter",
    });
    expect(after.prompts.get("blob").outcome?.summary).toBe("Shortened it.");
  });

  it("never shows an ended round before what it left is recorded", async () => {
    const a = app();
    await endedTurn(a);
    expect(a.prompts.get("blob")).toMatchObject({
      state: { name: "working", turn: "running" },
      outcome: null,
    });
    await a.rounds.recordSettled({
      taskId: "task_1",
      turnId: "trn_1",
      status: "completed",
      at: Date.now(),
    });
    expect(a.prompts.get("blob").state).toEqual({ name: "settled", outcome: "done" });
    expect(a.prompts.get("blob").outcome?.summary).toBe("Shortened it.");
  });

  it("counts the round's saved review ranges, and reads the same record until it changes", async () => {
    const a = app();
    await settledRound(a);
    const observation = storedRoundObserverFor(a.rounds.collection)("blob", () => {});
    const first = observation.get();
    expect(observation.get()).toBe(first);
    a.rounds.reviewRanges.save("/ws/other.md", {
      fingerprint: "f",
      changes: [
        { blobId: "blob", turnId: "trn_1", from: 1, to: 3 },
        { blobId: "blob", turnId: "trn_1", from: 5, to: 8 },
      ],
    });
    expect(observation.get()).not.toBe(first);
    expect(observation.get()?.changeCounts).toEqual({ "/ws/other.md": 2 });
    expect(a.prompts.get("blob").savedChangeCounts).toEqual({ "/ws/other.md": 2 });
    observation.destroy();
  });
});
