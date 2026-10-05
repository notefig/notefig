import { beforeEach, describe, expect, it } from "vitest";

import { updatePromptBlob } from "@notefig/widgets";
import type { ToolCallUpdate } from "@notefig/shared/agent";
import { calculateContentHash } from "@/utils/hash";
import { createTurnWrites, type TurnWritesApi } from "./turn-writes";

const disk = new Map<string, string>();
const fs = {
  readFiles: async (paths: string[]) => ({
    succeeded: paths
      .filter((path) => disk.has(path))
      .map((path) => ({ path, content: disk.get(path)! })),
    failed: [],
  }),
};

const DOC = "/ws/notes.md";

function edit(status: ToolCallUpdate["status"], id = "tc_1"): ToolCallUpdate {
  return {
    toolCallId: id,
    kind: "edit",
    status,
    locations: [{ path: DOC }],
  } as ToolCallUpdate;
}

let writes: TurnWritesApi;

const call = (toolCall: ToolCallUpdate, turnId = "trn_1") =>
  writes.recordToolCall({ taskId: "task_1", turnId, workspacePath: "/ws", toolCall });

describe("turn writes", () => {
  beforeEach(() => {
    writes = createTurnWrites({ fs });
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
    expect(writes.attribute(DOC, "any-hash")).toEqual({
      blobId: "blob_1",
      turnId: "trn_1",
    });
    expect(writes.attribute("/ws/other.md", "any-hash")).toBeNull();
  });

  it("credits the exact bytes a settled edit left, adopted later (native writes)", async () => {
    disk.set(DOC, "# written by the agent\n");
    await call(edit("pending"));
    await call(edit("completed"));
    const hash = calculateContentHash("# written by the agent\n");
    expect(writes.attribute(DOC, hash)).toEqual({
      blobId: "blob_1",
      turnId: "trn_1",
    });
    // Different bytes are someone else's change.
    expect(writes.attribute(DOC, calculateContentHash("user edit"))).toBeNull();
  });

  it("resolves a workspace-relative diff path", async () => {
    await call({
      toolCallId: "tc_rel",
      kind: "edit",
      status: "in_progress",
      content: [{ type: "diff", path: "./notes.md", oldText: null, newText: "x" }],
    } as ToolCallUpdate);
    expect(writes.attribute(DOC, "h")?.blobId).toBe("blob_1");
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
    expect(writes.attribute(DOC, calculateContentHash("round one"))?.turnId).toBe("trn_1");
    expect(writes.attribute(DOC, "other")?.turnId).toBe("trn_2");
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
    expect(writes.attribute(DOC, calculateContentHash("same bytes"))?.turnId).toBe("trn_2");
  });

  it("closes the calls a turn left open when it settles", async () => {
    disk.set(DOC, "partial");
    await call(edit("in_progress"));
    await writes.recordTurnSettled({ turnId: "trn_1" });
    expect(writes.attribute(DOC, "other")).toBeNull();
    expect(writes.attribute(DOC, calculateContentHash("partial"))).not.toBeNull();
  });

  it("ignores reads, and rounds no widget is watching", async () => {
    await call({ ...edit("in_progress"), kind: "read" } as ToolCallUpdate);
    expect(writes.attribute(DOC, "h")).toBeNull();

    await call(edit("in_progress", "tc_chat"), "trn_chat");
    expect(writes.attribute(DOC, "h")).toBeNull();

    // The widget moved on to a new turn: the old round's writes are no
    // longer its to show.
    await call(edit("in_progress", "tc_2"));
    updatePromptBlob("blob_1", { boundTurnId: "trn_2" });
    expect(writes.attribute(DOC, "h")).toBeNull();
  });
});
