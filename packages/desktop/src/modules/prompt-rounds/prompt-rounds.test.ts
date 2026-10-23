import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MAX_PROMPT_ROUNDS,
  PROMPT_ROUND_RETENTION_MS,
  createPromptRounds,
  derivePromptRounds,
  isLiveRound,
  roundsToEvict,
  type PromptRoundRow,
  type PromptRoundsApi,
} from "@/modules/prompt-rounds";
import type { AgentEntry, AgentTurn } from "@notefig/shared/agent";
import { createNodeTestDb } from "@/testing/node-db";
import { createHooks, type Hooks } from "@notefig/core";
import { workspaceKey } from "@/utils/path";

const started = (turnId: string, prompt = "Do the thing\nsecond line") => ({
  taskId: "task_1",
  turnId,
  workspacePath: "/ws/a",
  documentPath: "/ws/a/doc.md",
  prompt,
  blobId: "blob_1",
  typedPrompt: prompt,
});
const open = [{ key: workspaceKey("/ws/a"), path: "/ws/a" }];

describe("prompt rounds", () => {
  let rounds: PromptRoundsApi;
  /** The turn rows this run holds; a live round without one is an orphan. */
  let liveTurns: Set<string>;
  /** Turn rows that have already ended, by id. */
  let endedTurns: Map<string, Pick<AgentTurn, "status" | "error">>;
  let transcripts: Map<string, AgentEntry[]>;
  let hooks: Hooks;

  beforeEach(() => {
    liveTurns = new Set();
    endedTurns = new Map();
    transcripts = new Map();
    hooks = createHooks();
    rounds = createPromptRounds({
      persistence: createNodeTestDb().get(),
      turns: {
        get: (turnId) =>
          endedTurns.has(turnId)
            ? ({ turnId, ...endedTurns.get(turnId) } as never)
            : liveTurns.has(turnId)
              ? ({ turnId, status: "running" } as never)
              : undefined,
      },
      transcript: (_taskId, turnId) => transcripts.get(turnId) ?? [],
      hooks,
    });
  });

  it("records a started round (first line of the prompt) and settles it", async () => {
    await rounds.recordStarted(started("t1"), 10);
    await rounds.recordStarted(started("t1"), 11); // idempotent
    expect(rounds.collection.get("t1")).toMatchObject({
      taskId: "task_1",
      documentPath: "/ws/a/doc.md",
      prompt: "Do the thing",
      status: "live",
      startedAt: 10,
    });
    await rounds.recordSettled({ taskId: "task_1", turnId: "t1", status: "error", at: 42 });
    await rounds.recordSettled({ taskId: "task_1", turnId: "t_unknown", status: "completed", at: 43 });
    expect(rounds.collection.get("t1")).toMatchObject({ status: "error", settledAt: 42 });
    expect(rounds.collection.size).toBe(1);
  });

  it("ends a round whose turn ended before its start was announced", async () => {
    // A dead session settles the turn inside the send: the settle comes
    // first and finds no round.
    endedTurns.set("t1", { status: "error", error: "agent task is not started" });
    await rounds.recordSettled({ taskId: "task_1", turnId: "t1", status: "error", at: 9 });
    await rounds.recordStarted({ ...started("t1"), blobId: "blob_1" }, 10);
    expect(rounds.collection.get("t1")).toMatchObject({
      status: "error",
      settledAt: 10,
      outcome: { error: "agent task is not started" },
    });
  });

  it("reopens a round whose turn runs again, and settles it anew", async () => {
    // A sign-in interrupted the turn; the retry re-queues the same turn.
    await rounds.recordStarted({ ...started("t1"), blobId: "blob_1" }, 10);
    endedTurns.set("t1", { status: "error", error: "Authentication required" });
    await rounds.recordSettled({ taskId: "task_1", turnId: "t1", status: "error", at: 11 });
    endedTurns.delete("t1");
    await rounds.recordRequeued({ taskId: "task_1", turnId: "t1" });
    const reopened = rounds.collection.get("t1");
    expect(reopened?.status).toBe("live");
    expect(reopened?.settledAt).toBeUndefined();
    expect(reopened?.outcome).toBeUndefined();
    await rounds.recordSettled({ taskId: "task_1", turnId: "t1", status: "completed", at: 12 });
    expect(rounds.collection.get("t1")).toMatchObject({ status: "completed", settledAt: 12 });
  });

  it("keeps the prompt as typed, directives and all, beside the one sent", async () => {
    await rounds.recordStarted(
      {
        ...started("t1"),
        blobId: "blob_1",
        prompt: "Review this",
        typedPrompt: "@skill:review Review this",
      },
      10,
    );
    expect(rounds.collection.get("t1")).toMatchObject({
      prompt: "Review this",
      typedPrompt: "@skill:review Review this",
    });
  });

  it("records the widget and the whole prompt, and snapshots the outcome when it settles", async () => {
    await rounds.recordStarted({ ...started("t1"), blobId: "blob_1" }, 10);
    expect(rounds.collection.get("t1")).toMatchObject({
      blobId: "blob_1",
      workspacePath: "/ws/a",
      typedPrompt: "Do the thing\nsecond line",
    });
    transcripts.set("t1", [
      { id: "evt_1", turnId: "t1", taskId: "task_1", type: "assistant", text: "Shortened it." },
      {
        id: "evt_2",
        turnId: "t1",
        taskId: "task_1",
        type: "tool_call",
        toolCall: {
          toolCallId: "tc",
          kind: "edit",
          status: "completed",
          locations: [{ path: "/ws/a/doc.md" }],
        },
      },
    ] as unknown as AgentEntry[]);
    await rounds.recordSettled({ taskId: "task_1", turnId: "t1", status: "completed", at: 42 });
    expect(rounds.collection.get("t1")?.outcome).toEqual({
      response: null,
      summary: "Shortened it.",
      error: null,
      touchedFiles: ["/ws/a/doc.md"],
    });
  });

  it("keeps a document's review ranges on the rounds that made them", async () => {
    await rounds.recordStarted({ ...started("t1"), blobId: "blob_1" }, 10);
    await rounds.recordStarted({ ...started("t2"), blobId: "blob_2" }, 11);
    const saved = async () =>
      (await rounds.reviewRanges.loadAll()).get("/ws/a/doc.md");
    expect(await saved()).toBeUndefined();
    const changes = [
      { blobId: "blob_1", turnId: "t1", from: 1, to: 4 },
      { blobId: "blob_2", turnId: "t2", from: 9, to: 12 },
    ];
    rounds.reviewRanges.save("/ws/a/doc.md", { fingerprint: "f1", changes });
    await vi.waitFor(async () =>
      expect(await saved()).toEqual({ fingerprint: "f1", changes }),
    );
    // A later save replaces the document's ranges; others stay.
    rounds.reviewRanges.save("/ws/a/doc.md", { fingerprint: "f2", changes: [changes[1]] });
    await vi.waitFor(async () =>
      expect(await saved()).toEqual({ fingerprint: "f2", changes: [changes[1]] }),
    );
    expect(rounds.collection.get("t1")?.changes).toEqual([]);
  });

  it("forgets a widget's review ranges in every document", async () => {
    await rounds.recordStarted({ ...started("t1"), blobId: "blob_1" }, 10);
    await rounds.recordStarted({ ...started("t2"), blobId: "blob_2" }, 11);
    rounds.reviewRanges.save("/ws/a/doc.md", {
      fingerprint: "f",
      changes: [
        { blobId: "blob_1", turnId: "t1", from: 1, to: 4 },
        { blobId: "blob_2", turnId: "t2", from: 9, to: 12 },
      ],
    });
    const saved = async () =>
      (await rounds.reviewRanges.loadAll()).get("/ws/a/doc.md")?.changes;
    await vi.waitFor(async () => expect(await saved()).toHaveLength(2));
    rounds.reviewRanges.forget("blob_1");
    await vi.waitFor(async () =>
      expect(await saved()).toEqual([
        { blobId: "blob_2", turnId: "t2", from: 9, to: 12 },
      ]),
    );
  });

  it("settles rounds left live by a previous run, keeps live ones with a turn row", async () => {
    await rounds.recordStarted(started("t_orphan"), 1);
    await rounds.recordStarted(started("t_kept"), 2);
    liveTurns.add("t_kept");
    await rounds.settleOrphaned();
    expect(rounds.collection.get("t_orphan")?.status).toBe("cancelled");
    // Settled now, so it ages out like any other settled round.
    expect(rounds.collection.get("t_orphan")?.settledAt).toBeGreaterThan(0);
    expect(rounds.collection.get("t_kept")?.status).toBe("live");
  });

  it("prunes storage to the cap, oldest first", async () => {
    for (let i = 0; i < MAX_PROMPT_ROUNDS + 2; i += 1) {
      await rounds.recordStarted(started(`t${i}`), i);
    }
    expect(rounds.collection.size).toBe(MAX_PROMPT_ROUNDS);
    expect(rounds.collection.get("t0")).toBeUndefined();
  });

  it("derives rounds for open workspaces: live first (queued/running off the turn), then newest", () => {
    const key = workspaceKey("/ws/a");
    const row = (turnId: string, status: "live" | "completed", startedAt: number, wsKey = key) => ({
      turnId, taskId: "task_1", workspaceKey: wsKey, documentPath: "/ws/a/doc.md", prompt: "p", status, startedAt,
    });
    const rounds = derivePromptRounds(
      [row("old", "completed", 10), row("new", "completed", 20), row("live", "live", 5), row("queued", "live", 6), row("gone", "live", 7), row("closed", "completed", 99, "other")],
      open,
      [
        { turnId: "queued", status: "queued" },
        { turnId: "live", status: "running" },
      ],
    );
    // "gone" is live with no turn row — the round is over, not running
    // (MET-208): the same answer settleOrphaned writes at boot.
    expect(rounds.map((r) => [r.turnId, r.status])).toEqual([
      ["queued", "queued"],
      ["live", "running"],
      ["new", "completed"],
      ["old", "completed"],
      ["gone", "cancelled"],
    ]);
    expect(rounds[0].workspacePath).toBe("/ws/a");
    expect(isLiveRound(rounds[0])).toBe(true);
    expect(isLiveRound(rounds[2])).toBe(false);
  });

  it("the boot listener records rounds from the app events", async () => {
    const stop = rounds.track();
    hooks.emit("widget:round-started", started("t9"));
    await vi.waitFor(() => expect(rounds.collection.get("t9")).toBeDefined());
    hooks.emit("agent:turn-settled", { taskId: "task_1", turnId: "t9", status: "completed", at: 1 });
    await vi.waitFor(() => expect(rounds.collection.get("t9")?.status).toBe("completed"));
    stop();
  });
});

describe("roundsToEvict", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 100 * DAY;
  const row = (turnId: string, startedAt: number, extra: Partial<PromptRoundRow> = {}): PromptRoundRow => ({
    turnId, taskId: "task_1", workspaceKey: "k", documentPath: "/d.md", prompt: "p",
    status: "completed", startedAt, settledAt: startedAt, ...extra,
  });

  it("drops settled rounds past the retention window, never live ones", () => {
    const rows = [
      row("old", NOW - PROMPT_ROUND_RETENTION_MS - DAY),
      row("recent", NOW - DAY),
      row("live", NOW - 30 * DAY, { status: "live", settledAt: undefined }),
    ];
    expect(roundsToEvict(rows, NOW)).toEqual(["old"]);
  });

  it("ages a settled round with no settle time from when it started", () => {
    const rows = [
      row("legacy", NOW - PROMPT_ROUND_RETENTION_MS - DAY, { status: "cancelled", settledAt: undefined }),
    ];
    expect(roundsToEvict(rows, NOW)).toEqual(["legacy"]);
  });

  it("caps storage oldest first, but keeps each widget's newest round", () => {
    const rows = Array.from({ length: MAX_PROMPT_ROUNDS + 2 }, (_, i) =>
      row(`t${i}`, NOW - DAY + i, i === 0 ? { blobId: "blob_kept" } : {}),
    );
    const doomed = roundsToEvict(rows, NOW);
    expect(doomed).toHaveLength(2);
    expect(doomed).not.toContain("t0");
    expect(doomed).toEqual(["t1", "t2"]);
  });
});
