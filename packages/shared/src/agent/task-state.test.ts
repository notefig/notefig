import { describe, expect, it } from "vitest";
import { transcriptRows, type AgentEntry, type AgentTurn } from "./task-state";

const turn = (turnId: string, extra: Partial<AgentTurn> = {}): AgentTurn => ({
  turnId,
  taskId: "task",
  sessionId: "sess",
  status: "completed",
  startedAt: 0,
  ...extra,
});

const entry = (id: string, turnId: string, type: AgentEntry["type"] = "assistant"): AgentEntry => ({
  id,
  taskId: "task",
  turnId,
  type,
  createdAt: 0,
});

/** The rows as `user/assistant/error:turn`, in order. */
const shape = (entries: AgentEntry[], turns: AgentTurn[]) =>
  transcriptRows(entries, turns).map((row) =>
    row.kind === "error" ? `error:${row.turn.turnId}` : `${row.entry.type}:${row.entry.turnId}`,
  );

describe("transcriptRows", () => {
  it("reads in entry order, whatever order the rows came in", () => {
    expect(
      shape([entry("e2", "t1"), entry("e1", "t1", "user")], [turn("t1")]),
    ).toEqual(["user:t1", "assistant:t1"]);
  });

  it("puts a failed turn's error after its last entry, above the turns after it", () => {
    const entries = [
      entry("e1", "t1", "user"),
      entry("e2", "t2", "user"), // queued while t1 still ran
      entry("e3", "t1"),
      entry("e4", "t2"),
    ];
    expect(
      shape(entries, [turn("t1", { status: "error", error: "Overloaded" }), turn("t2")]),
    ).toEqual(["user:t1", "user:t2", "assistant:t1", "error:t1", "assistant:t2"]);
  });

  it("puts an error whose turn has no entries left last", () => {
    expect(
      shape([entry("e1", "t2", "user")], [turn("t1", { status: "error", error: "gone" }), turn("t2")]),
    ).toEqual(["user:t2", "error:t1"]);
  });

  it("shows no error for a failed turn without a message, nor once a retry cleared it", () => {
    expect(
      shape([entry("e1", "t1", "user")], [turn("t1", { status: "queued" })]),
    ).toEqual(["user:t1"]);
  });

  it("marks a queued prompt and carries a settled turn's usage on its prompt", () => {
    const usage = { inputTokens: 1, outputTokens: 2 } as AgentTurn["usage"];
    const rows = transcriptRows(
      [entry("e1", "t1", "user"), entry("e2", "t1"), entry("e3", "t2", "user")],
      [turn("t1", { usage }), turn("t2", { status: "queued" })],
    );
    expect(rows.map((row) => (row.kind === "entry" ? [row.queued, row.usage] : null))).toEqual([
      [false, usage],
      [false, undefined],
      [true, undefined],
    ]);
  });
});
