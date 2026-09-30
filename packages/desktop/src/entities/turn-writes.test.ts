import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Map<string, string>();
vi.mock("@/adapters", () => ({
  platformAdapter: {
    fs: {
      readFiles: async (paths: string[]) => ({
        succeeded: paths
          .filter((path) => disk.has(path))
          .map((path) => ({ path, content: disk.get(path)! })),
        failed: [],
      }),
    },
  },
}));

import { updatePromptBlob } from "@notefig/widgets";
import type { ToolCallUpdate } from "@notefig/shared/agent";
import { calculateContentHash } from "@/utils/hash";
import {
  attributeAdoption,
  recordToolCall,
  recordTurnSettled,
  resetTurnWritesForTest,
} from "./turn-writes";

const DOC = "/ws/notes.md";

function edit(status: ToolCallUpdate["status"], id = "tc_1"): ToolCallUpdate {
  return {
    toolCallId: id,
    kind: "edit",
    status,
    locations: [{ path: DOC }],
  } as ToolCallUpdate;
}

const call = (toolCall: ToolCallUpdate, turnId = "trn_1") =>
  recordToolCall({ taskId: "task_1", turnId, workspacePath: "/ws", toolCall });

describe("turn writes", () => {
  beforeEach(() => {
    resetTurnWritesForTest();
    disk.clear();
    // A widget that sent is mounted, so its document is known.
    updatePromptBlob("blob_1", {
      boundTaskId: "task_1",
      boundTurnId: "trn_1",
      documentPath: DOC,
    });
  });

  it("credits a write adopted while its edit is in flight (ACP fs writes)", async () => {
    await call(edit("in_progress"));
    expect(attributeAdoption(DOC, "any-hash")).toEqual({
      blobId: "blob_1",
      turnId: "trn_1",
    });
    expect(attributeAdoption("/ws/other.md", "any-hash")).toBeNull();
  });

  it("credits the exact bytes a settled edit left, adopted later (native writes)", async () => {
    disk.set(DOC, "# written by the agent\n");
    await call(edit("pending"));
    await call(edit("completed"));
    const hash = calculateContentHash("# written by the agent\n");
    expect(attributeAdoption(DOC, hash)).toEqual({
      blobId: "blob_1",
      turnId: "trn_1",
    });
    // Different bytes are someone else's change.
    expect(attributeAdoption(DOC, calculateContentHash("user edit"))).toBeNull();
  });

  it("resolves a workspace-relative diff path", async () => {
    await call({
      toolCallId: "tc_rel",
      kind: "edit",
      status: "in_progress",
      content: [{ type: "diff", path: "./notes.md", oldText: null, newText: "x" }],
    } as ToolCallUpdate);
    expect(attributeAdoption(DOC, "h")?.blobId).toBe("blob_1");
  });

  it("prefers the round whose settled write matches over a later call in flight", async () => {
    updatePromptBlob("blob_2", {
      boundTaskId: "task_1",
      boundTurnId: "trn_2",
      documentPath: DOC,
    });
    // Round two starts editing, then round one's edit settles.
    disk.set(DOC, "round one");
    await call(edit("in_progress", "tc_2"), "trn_2");
    await call(edit("completed"));
    expect(attributeAdoption(DOC, calculateContentHash("round one"))?.turnId).toBe("trn_1");
    expect(attributeAdoption(DOC, "other")?.turnId).toBe("trn_2");
  });

  it("credits a later round that writes an earlier round's bytes back", async () => {
    updatePromptBlob("blob_2", {
      boundTaskId: "task_1",
      boundTurnId: "trn_2",
      documentPath: DOC,
    });
    disk.set(DOC, "same bytes");
    await call(edit("completed"));
    await call(edit("in_progress", "tc_2"), "trn_2");
    expect(attributeAdoption(DOC, calculateContentHash("same bytes"))?.turnId).toBe("trn_2");
  });

  it("closes the calls a turn left open when it settles", async () => {
    disk.set(DOC, "partial");
    await call(edit("in_progress"));
    await recordTurnSettled({ turnId: "trn_1" });
    expect(attributeAdoption(DOC, "other")).toBeNull();
    expect(attributeAdoption(DOC, calculateContentHash("partial"))).not.toBeNull();
  });

  it("ignores reads, and rounds no widget is watching", async () => {
    await call({ ...edit("in_progress"), kind: "read" } as ToolCallUpdate);
    expect(attributeAdoption(DOC, "h")).toBeNull();

    await call(edit("in_progress", "tc_chat"), "trn_chat");
    expect(attributeAdoption(DOC, "h")).toBeNull();

    // The widget moved on to a new turn: the old round's writes are no
    // longer its to show.
    await call(edit("in_progress", "tc_2"));
    updatePromptBlob("blob_1", { boundTurnId: "trn_2" });
    expect(attributeAdoption(DOC, "h")).toBeNull();
  });
});
