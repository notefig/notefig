/**
 * The prompt widgets over the app's agent store: each widget's state
 * follows its round's rows as the agent service writes them.
 */
import { describe, expect, it, vi } from "vitest";
import { createPromptWidgets } from "@notefig/widgets";
import { createHooks } from "@notefig/core";
import type { AgentEntry, AgentTurn } from "@/modules/agents/agent-collections";
import { createPromptRounds } from "@/modules/prompt-rounds";
import { createNodeTestDb } from "@/testing/node-db";
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

/** The app's pieces as the modules wire them, over one database. */
function app(db = createNodeTestDb()) {
  const store = testAgentStore();
  const hooks = createHooks();
  const rounds = createPromptRounds({
    persistence: db.get(),
    turns: store.turns,
    transcript: (taskId, turnId) =>
      store.entriesForTask(taskId).filter((entry) => entry.turnId === turnId),
    hooks,
  });
  rounds.track();
  const prompts = createPromptWidgets({
    observeRound: roundObserverFor(store),
    observeStoredRound: rounds.observeNewest,
    announceRound: (round) => hooks.emit("widget:round-started", round),
    reviewRanges: rounds.reviewRanges,
  });
  return { db, store, hooks, rounds, prompts };
}

/** Send from "blob", the dispatch writing the queued turn row. */
async function sent(a = app()) {
  await a.prompts.send("blob", "@skill:edit make it shorter", async () => {
    a.store.turns.insert(turn("queued"));
    return {
      taskId: "task_1",
      turnId: "trn_1",
      workspacePath: "/ws",
      documentPath: "/ws/doc.md",
      sentPrompt: "make it shorter",
    };
  });
  return a;
}

describe("promptWidgets over the agent store", () => {
  it("follows the bound turn through its statuses", async () => {
    const { store, prompts, rounds } = await sent();
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
    await rounds.recordSettled({
      taskId: "task_1",
      turnId: "trn_1",
      status: "completed",
      at: Date.now(),
    });
    expect(prompts.get("blob").state).toEqual({ name: "settled", outcome: "done" });
  });

  it("ends the round cancelled, keeping the session, when the turn's row is deleted", async () => {
    // What a session revival's replay does to a turn it never finished.
    const { store, prompts } = await sent();
    store.turns.delete("trn_1");
    expect(prompts.get("blob")).toMatchObject({
      state: { name: "settled", outcome: "cancelled" },
      boundTaskId: "task_1",
    });
  });

  it("announces the round it starts, recorded with the prompt as sent and as typed", async () => {
    const { rounds } = await sent();
    await vi.waitFor(() =>
      expect(rounds.collection.get("trn_1")).toMatchObject({
        blobId: "blob",
        documentPath: "/ws/doc.md",
        prompt: "make it shorter",
        typedPrompt: "@skill:edit make it shorter",
      }),
    );
  });
});

describe("promptWidgets over stored rounds (MET-251)", () => {
  /** Send and answer, the turn row ending — as the agent service would —
   *  but the round not yet recorded as ended. */
  async function endedTurn(a = app()) {
    await sent(a);
    await vi.waitFor(() => expect(a.rounds.collection.get("trn_1")).toBeDefined());
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
    return a;
  }

  /** …and the round recorded as ended, with what it left. */
  async function settledRound(a = app()) {
    await endedTurn(a);
    await a.rounds.recordSettled({
      taskId: "task_1",
      turnId: "trn_1",
      status: "completed",
      at: Date.now(),
    });
    return a;
  }

  it("keeps a settled widget's face when a revival replays its turn away", async () => {
    const a = await settledRound();
    expect(a.prompts.get("blob").outcome?.summary).toBe("Shortened it.");
    a.store.turns.delete("trn_1");
    expect(a.prompts.get("blob")).toMatchObject({
      state: { name: "settled", outcome: "done" },
      boundTurnId: "trn_1",
    });
    expect(a.prompts.get("blob").outcome?.summary).toBe("Shortened it.");
  });

  it("brings a widget back as it was left after a restart, its review ranges too", async () => {
    const before = await settledRound();
    before.rounds.reviewRanges.save("/ws/other.md", {
      fingerprint: "f",
      changes: [
        { blobId: "blob", turnId: "trn_1", from: 1, to: 3 },
        { blobId: "blob", turnId: "trn_1", from: 5, to: 8 },
      ],
    });
    await vi.waitFor(() =>
      expect(before.rounds.collection.get("trn_1")?.changes).toHaveLength(1),
    );
    // A new run over the same database: no turn rows, no widget state.
    const after = app(before.db);
    await after.rounds.collection.preload();
    after.prompts.restore("blob", "task_1");
    expect(after.prompts.get("blob")).toMatchObject({
      state: { name: "settled", outcome: "done" },
      boundTurnId: "trn_1",
      // As typed: Edit and Retry put the directive back.
      lastSentPrompt: "@skill:edit make it shorter",
      // Over before this run: nothing new to see.
      seenTurnId: "trn_1",
    });
    expect(after.prompts.get("blob").outcome?.summary).toBe("Shortened it.");
    await vi.waitFor(() =>
      expect(after.prompts.review.counts("blob")).toEqual(new Map([["/ws/other.md", 2]])),
    );
  });

  it("never shows an ended round before what it left is recorded", async () => {
    const a = await endedTurn();
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

  it("reads the same record until it changes", async () => {
    const a = await settledRound();
    const observation = a.rounds.observeNewest("blob", () => {});
    const first = observation.get();
    expect(observation.get()).toBe(first);
    await a.rounds.recordRequeued({ taskId: "task_1", turnId: "trn_1" });
    expect(observation.get()).not.toBe(first);
    expect(observation.get()?.status).toBe("live");
    observation.destroy();
  });
});
