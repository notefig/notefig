import { describe, it, expect } from "vitest";
import { SESSION_COLOR_SLOTS, SESSION_SHAPES, type AgentTaskRow } from "@notefig/shared/agent";
import { pickSessionMark } from "../session-color";

const row = (
  taskId: string,
  colorSlot: number | undefined,
  extra: Partial<AgentTaskRow> = {},
) => ({
  taskId,
  workspacePath: "/ws",
  status: "idle" as const,
  updatedAt: 1,
  ...(colorSlot === undefined ? {} : { colorSlot, shapeSlot: colorSlot }),
  ...extra,
});
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
/** Always the first free slot, so the other cases read like a list. */
const first = () => 0;

describe("pickSessionMark", () => {
  it("takes a color and shape no other session of the workspace holds", () => {
    expect(pickSessionMark([], "/ws", undefined, first)).toEqual({ colorSlot: 0, shapeSlot: 0 });
    expect(pickSessionMark([row("a", 0), row("b", 2)], "/ws", undefined, first)).toEqual({
      colorSlot: 1,
      shapeSlot: 1,
    });
  });

  it("picks at random among the free ones, never a held one", () => {
    const rows = [row("a", 0), row("b", 2)];
    // The last of the free slots: colors 1, 3…11; shapes 1, 3…23.
    expect(pickSessionMark(rows, "/ws", undefined, () => 0.999)).toEqual({ colorSlot: 11, shapeSlot: 23 });
    // A spread of draws only ever lands on free slots.
    for (let draw = 0; draw < 1; draw += 0.01) {
      const { colorSlot, shapeSlot } = pickSessionMark(rows, "/ws", undefined, () => draw);
      expect([0, 2]).not.toContain(colorSlot);
      expect([0, 2]).not.toContain(shapeSlot);
    }
  });

  it("picks color and shape apart: past twelve sessions colors repeat, shapes don't", () => {
    const rows = range(SESSION_COLOR_SLOTS).map((slot) => row(`t${slot}`, slot, { updatedAt: 10 + slot }));
    expect(pickSessionMark(rows, "/ws", undefined, first)).toEqual({
      colorSlot: 0,
      shapeSlot: SESSION_COLOR_SLOTS,
    });
  });

  it("counts only the workspace's own sessions", () => {
    expect(pickSessionMark([row("a", 0, { workspacePath: "/other" })], "/ws", undefined, first).colorSlot).toBe(0);
  });

  it("frees an unavailable session's slots, and ignores rows with none", () => {
    const rows = [row("a", 0, { status: "unavailable" }), row("b", undefined)];
    expect(pickSessionMark(rows, "/ws", undefined, first)).toEqual({ colorSlot: 0, shapeSlot: 0 });
  });

  it("doesn't count the session it picks for", () => {
    expect(pickSessionMark([row("a", 0)], "/ws", "a", first).colorSlot).toBe(0);
  });

  it("reuses the shape of the session left untouched longest once all are held", () => {
    const rows = range(SESSION_SHAPES).map((slot) => row(`t${slot}`, slot, { updatedAt: 10 + slot }));
    rows[3] = row("t3", 3, { updatedAt: 2 });
    expect(pickSessionMark(rows, "/ws").shapeSlot).toBe(3);
  });

  it("judges a shared color by its most recent holder", () => {
    const rows = range(SESSION_COLOR_SLOTS).map((slot) => row(`t${slot}`, slot, { updatedAt: 10 }));
    // Color 0 has an old holder but also a recent one; color 4 only an old one.
    rows.push(row("old0", undefined, { colorSlot: 0, updatedAt: 1 }));
    rows[4] = row("t4", 4, { updatedAt: 3 });
    expect(pickSessionMark(rows, "/ws").colorSlot).toBe(4);
  });
});
