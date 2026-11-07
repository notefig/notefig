import { describe, expect, it, vi } from "vitest";
import { createWriteGate, type GatedWrite } from "./write-gate";

const write: GatedWrite = {
  workspacePath: "/ws",
  path: "/ws/a.md",
  content: "x",
  writer: { kind: "agent", taskId: "t1", harness: "claude" },
};

describe("write gate", () => {
  it("performs the write when no gate is registered", async () => {
    const perform = vi.fn(async () => {});
    await createWriteGate().run(write, perform);
    expect(perform).toHaveBeenCalledOnce();
  });

  it("a gate that throws first refuses: nothing is written", async () => {
    const gate = createWriteGate();
    gate.register(async () => {
      throw new Error("held by Ada");
    });
    const perform = vi.fn(async () => {});
    await expect(gate.run(write, perform)).rejects.toThrow("held by Ada");
    expect(perform).not.toHaveBeenCalled();
  });

  it("gates wrap each other in order, run the write once, and come off when unregistered", async () => {
    const gate = createWriteGate();
    const order: string[] = [];
    gate.register(async (_w, perform) => {
      order.push("outer:before");
      await perform();
      await perform();
      order.push("outer:after");
    });
    const off = gate.register(async (_w, perform) => {
      order.push("inner");
      await perform();
    });
    const perform = vi.fn(async () => void order.push("write"));
    await gate.run(write, perform);
    expect(order).toEqual(["outer:before", "inner", "write", "outer:after"]);
    off();
    order.length = 0;
    await gate.run(write, perform);
    expect(order).toEqual(["outer:before", "write", "outer:after"]);
  });
});
