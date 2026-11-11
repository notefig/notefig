import { describe, it, expect } from "vitest";
import type { AgentTaskRow } from "@notefig/shared/agent";
import { pickColorSlot } from "../session-color";

const row = (taskId: string, colorSlot: number | undefined, extra: Partial<AgentTaskRow> = {}) => ({
  taskId,
  workspacePath: "/ws",
  status: "idle" as const,
  updatedAt: 1,
  ...(colorSlot === undefined ? {} : { colorSlot }),
  ...extra,
});

describe("pickColorSlot", () => {
  it("takes the lowest slot no other session of the workspace holds", () => {
    expect(pickColorSlot([], "/ws")).toBe(0);
    expect(pickColorSlot([row("a", 0), row("b", 2)], "/ws")).toBe(1);
  });

  it("counts only the workspace's own sessions", () => {
    expect(pickColorSlot([row("a", 0, { workspacePath: "/other" })], "/ws")).toBe(0);
  });

  it("frees an unavailable session's slot, and ignores rows with none", () => {
    expect(pickColorSlot([row("a", 0, { status: "unavailable" }), row("b", undefined)], "/ws")).toBe(0);
  });

  it("doesn't count the session it picks for", () => {
    expect(pickColorSlot([row("a", 0)], "/ws", "a")).toBe(0);
  });

  it("reuses the slot of the session left untouched longest once all six are held", () => {
    const rows = [0, 1, 2, 3, 4, 5].map((slot) => row(`t${slot}`, slot, { updatedAt: 10 + slot }));
    rows[3] = row("t3", 3, { updatedAt: 2 });
    expect(pickColorSlot(rows, "/ws")).toBe(3);
  });

  it("judges a shared slot by its most recent holder", () => {
    const rows = [0, 1, 2, 3, 4, 5].map((slot) => row(`t${slot}`, slot, { updatedAt: 10 }));
    // Slot 0 has an old holder but also a recent one; slot 4 only an old one.
    rows.push(row("old0", 0, { updatedAt: 1 }));
    rows[4] = row("t4", 4, { updatedAt: 3 });
    expect(pickColorSlot(rows, "/ws")).toBe(4);
  });
});
