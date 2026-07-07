import { describe, it, expect, vi } from "vitest";
import { AgentWriteGate } from "../agent-write-gate";
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";

/** Minimal adapter whose writeFiles resolution can be controlled per call. */
function makeAdapter(onWrite: (path: string) => Promise<void>) {
  return {
    writeFiles: vi.fn(async (files: { path: string; content: string }[]) => {
      await onWrite(files[0].path);
      return { succeeded: files.map((f) => f.path), failed: [] };
    }),
    readFiles: vi.fn(async (paths: string[]) => ({
      succeeded: paths.map((p) => ({ path: p, content: "x" })),
      failed: [],
    })),
  } as unknown as IPlatformAdapter;
}

describe("AgentWriteGate", () => {
  it("serializes writes to the same path (no interleave)", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let call = 0;

    const adapter = makeAdapter(async () => {
      const n = call++;
      order.push(`start-${n}`);
      if (n === 0) await firstGate;
      order.push(`end-${n}`);
    });
    const gate = new AgentWriteGate(adapter);

    const a = gate.writeTextFile("task-1", "/f.md", "a");
    const b = gate.writeTextFile("task-2", "/f.md", "b");
    // Second write must not start until the first ends.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start-0"]);
    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(["start-0", "end-0", "start-1", "end-1"]);
  });

  it("does not block writes to different paths", async () => {
    const adapter = makeAdapter(async () => {});
    const gate = new AgentWriteGate(adapter);
    await Promise.all([
      gate.writeTextFile("t", "/a.md", "1"),
      gate.writeTextFile("t", "/b.md", "2"),
    ]);
    expect((adapter.writeFiles as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("surfaces two tasks touching one path as an overlap", async () => {
    const adapter = makeAdapter(async () => {});
    const gate = new AgentWriteGate(adapter);
    await gate.writeTextFile("task-1", "/shared.md", "a");
    await gate.writeTextFile("task-2", "/shared.md", "b");

    expect(gate.getRecentWriters("/shared.md").sort()).toEqual([
      "task-1",
      "task-2",
    ]);
    const overlaps = gate.getOverlappingPaths();
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].path).toBe("/shared.md");
    expect(overlaps[0].taskIds.sort()).toEqual(["task-1", "task-2"]);
  });

  it("propagates a write failure as an FsError", async () => {
    const adapter = {
      writeFiles: vi.fn(async () => ({
        succeeded: [],
        failed: [{ type: "io_error", path: "/f.md", message: "disk full" }],
      })),
      readFiles: vi.fn(),
    } as unknown as IPlatformAdapter;
    const gate = new AgentWriteGate(adapter);
    await expect(gate.writeTextFile("t", "/f.md", "x")).rejects.toThrow(
      "disk full",
    );
  });
});
