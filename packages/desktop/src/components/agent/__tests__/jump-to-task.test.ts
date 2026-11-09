import { describe, expect, it, vi } from "vitest";
import { jumpToRound, jumpToTask, type Jumper } from "../jump-to-task";

/** A jumper over spies, with the round's widget mounted or not. */
function jumper(widget: { boundTurnId: string } | null = null) {
  const tabs = {
    open: vi.fn(() => true),
    openAgent: vi.fn(),
    reveal: vi.fn(async () => true),
  };
  const core: Jumper = {
    tabs,
    promptWidgets: {
      findByTask: () =>
        widget && ({ documentPath: "/ws/doc.md", blobId: "b1", ...widget } as never),
    },
  };
  return { core, tabs };
}

const round = { taskId: "t1", turnId: "u1", documentPath: "/ws/doc.md" };

describe("jumping from a sidebar row opens like a file from the tree", () => {
  it("a session with no widget opens its chat in place by default", () => {
    const { core, tabs } = jumper();
    expect(jumpToTask(core, "t1")).toBe("chat");
    expect(tabs.openAgent).toHaveBeenCalledWith("t1", { intent: "replace" });
  });

  it("a session opens its chat in a new tab when the gesture asks", () => {
    const { core, tabs } = jumper();
    jumpToTask(core, "t1", { intent: "new-tab" });
    expect(tabs.openAgent).toHaveBeenCalledWith("t1", { intent: "new-tab" });
  });

  it("a prompt's document opens with the gesture's intent", () => {
    const { core, tabs } = jumper();
    jumpToRound(core, round);
    expect(tabs.open).toHaveBeenLastCalledWith("/ws/doc.md", { intent: "replace" });
    jumpToRound(core, round, { intent: "new-tab" });
    expect(tabs.open).toHaveBeenLastCalledWith("/ws/doc.md", { intent: "new-tab" });
  });

  it("a mounted widget is revealed with the gesture's intent", () => {
    const { core, tabs } = jumper({ boundTurnId: "u1" });
    jumpToRound(core, round, { intent: "new-tab" });
    expect(tabs.reveal).toHaveBeenCalledWith(
      "/ws/doc.md",
      { blockId: "b1" },
      { intent: "new-tab", moveIfOpen: true },
    );
    jumpToTask(core, "t1");
    expect(tabs.reveal).toHaveBeenLastCalledWith(
      "/ws/doc.md",
      { blockId: "b1" },
      { intent: "replace", moveIfOpen: true },
    );
  });
});
