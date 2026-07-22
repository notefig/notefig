import { describe, it, expect, vi } from "vitest";

vi.mock("@/adapters", () => ({ platformAdapter: {} }));

import type {
  AgentEntry,
  AgentTaskRow,
  AgentTurn,
} from "@/agent/agent-collections";
import type { ToolCallUpdate } from "@metrists/shared/agent";
import {
  derivePhase,
  deriveActiveToolLine,
  deriveLatestAssistantLine,
  deriveTouchedFiles,
  deriveQueuePosition,
  deriveComposerKeyAction,
} from "../prompt-blob-state";

function turn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    turnId: "trn_1",
    taskId: "task_1",
    sessionId: "s",
    status: "running",
    startedAt: 0,
    ...overrides,
  };
}

function task(overrides: Partial<AgentTaskRow> = {}): AgentTaskRow {
  return {
    taskId: "task_1",
    workspacePath: "/ws",
    title: "t",
    status: "running",
    harnessId: "claude-code",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function toolEntry(
  id: string,
  toolCall: Partial<ToolCallUpdate>,
): AgentEntry {
  return {
    id,
    taskId: "task_1",
    turnId: "trn_1",
    type: "tool_call",
    toolCall: { toolCallId: id, ...toolCall } as ToolCallUpdate,
    createdAt: 0,
  };
}

describe("derivePhase", () => {
  const base = { task: task(), hasPendingPermission: false, isSending: false };

  it("covers the lifecycle", () => {
    expect(derivePhase({ ...base, turn: undefined })).toBe("composing");
    expect(derivePhase({ ...base, turn: undefined, isSending: true })).toBe(
      "sending",
    );
    expect(derivePhase({ ...base, turn: turn({ status: "queued" }) })).toBe(
      "queued",
    );
    expect(derivePhase({ ...base, turn: turn() })).toBe("running");
    expect(derivePhase({ ...base, turn: turn({ status: "completed" }) })).toBe(
      "done",
    );
    expect(derivePhase({ ...base, turn: turn({ status: "cancelled" }) })).toBe(
      "done",
    );
    expect(
      derivePhase({ ...base, turn: turn({ status: "error", error: "x" }) }),
    ).toBe("error");
  });

  it("permission only surfaces while running", () => {
    expect(
      derivePhase({ ...base, turn: turn(), hasPendingPermission: true }),
    ).toBe("needs-permission");
    expect(
      derivePhase({
        ...base,
        turn: turn({ status: "queued" }),
        hasPendingPermission: true,
      }),
    ).toBe("queued");
  });

  it("auth block outranks queued/running/error but not completed", () => {
    const authTask = task({ authRequired: true });
    expect(
      derivePhase({ ...base, task: authTask, turn: turn({ status: "queued" }) }),
    ).toBe("needs-auth");
    expect(
      derivePhase({ ...base, task: authTask, turn: turn({ status: "error" }) }),
    ).toBe("needs-auth");
    expect(
      derivePhase({
        ...base,
        task: authTask,
        turn: turn({ status: "completed" }),
      }),
    ).toBe("done");
  });
});

describe("deriveActiveToolLine", () => {
  it("picks the latest in-flight call, labeling title and file", () => {
    const entries = [
      toolEntry("evt_1", { title: "Read file", status: "completed" }),
      toolEntry("evt_2", {
        title: "Edit",
        status: "in_progress",
        locations: [{ path: "/ws/docs/pricing.md" }],
      }),
    ];
    expect(deriveActiveToolLine(entries)).toBe("Edit · pricing.md");
  });

  it("never returns an empty string (blank labels would reserve blank space)", () => {
    expect(
      deriveActiveToolLine([
        toolEntry("evt_1", { title: "  ", status: "in_progress" }),
      ]),
    ).toBeNull();
  });

  it("falls back to title alone, and to null when nothing is in flight", () => {
    expect(
      deriveActiveToolLine([toolEntry("evt_1", { title: "Search", status: "pending" })]),
    ).toBe("Search");
    expect(
      deriveActiveToolLine([toolEntry("evt_1", { title: "Search", status: "completed" })]),
    ).toBeNull();
    expect(deriveActiveToolLine([])).toBeNull();
  });
});

function assistantEntry(id: string, text: string | undefined): AgentEntry {
  return {
    id,
    taskId: "task_1",
    turnId: "trn_1",
    type: "assistant",
    text,
    createdAt: 0,
  };
}

describe("deriveLatestAssistantLine", () => {
  it("picks the latest assistant entry's trimmed text", () => {
    const entries = [
      assistantEntry("evt_1", "first draft"),
      toolEntry("evt_2", { title: "Edit", status: "completed" }),
      assistantEntry("evt_3", "  latest text  "),
    ];
    expect(deriveLatestAssistantLine(entries)).toBe("latest text");
  });

  it("does not fall back to an earlier assistant entry when the latest one is blank", () => {
    const entries = [
      assistantEntry("evt_1", "earlier text"),
      assistantEntry("evt_2", "   "),
    ];
    expect(deriveLatestAssistantLine(entries)).toBeNull();
  });

  it("never returns an empty string for whitespace-only text", () => {
    expect(deriveLatestAssistantLine([assistantEntry("evt_1", "   ")])).toBeNull();
    expect(deriveLatestAssistantLine([assistantEntry("evt_1", undefined)])).toBeNull();
  });

  it("returns null for an empty entries array", () => {
    expect(deriveLatestAssistantLine([])).toBeNull();
  });
});

describe("deriveTouchedFiles", () => {
  it("includes mutating kinds and diff-content calls, deduped", () => {
    const entries = [
      toolEntry("evt_1", {
        kind: "edit",
        status: "completed",
        locations: [{ path: "/ws/a.md" }],
      }),
      toolEntry("evt_2", {
        kind: "other",
        status: "completed",
        content: [{ type: "diff", path: "/ws/a.md", newText: "x" }],
        locations: [{ path: "/ws/a.md" }],
      }),
      toolEntry("evt_3", {
        kind: "delete",
        status: "completed",
        locations: [{ path: "/ws/b.md" }],
      }),
    ];
    expect(deriveTouchedFiles(entries, "/ws")).toEqual(["/ws/a.md", "/ws/b.md"]);
  });

  it("excludes reads/searches and resolves relative diff paths", () => {
    const entries = [
      toolEntry("evt_1", {
        kind: "read",
        status: "completed",
        locations: [{ path: "/ws/read-only.md" }],
      }),
      toolEntry("evt_2", {
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", path: "notes/c.md", newText: "x" }],
      }),
    ];
    expect(deriveTouchedFiles(entries, "/ws")).toEqual(["/ws/notes/c.md"]);
  });
});

describe("deriveComposerKeyAction", () => {
  it("Enter without Shift always sends, regardless of draft/revert state", () => {
    expect(
      deriveComposerKeyAction({
        key: "Enter",
        shiftKey: false,
        draftEmpty: false,
        canRevert: false,
      }),
    ).toEqual({ type: "send" });
    expect(
      deriveComposerKeyAction({
        key: "Enter",
        shiftKey: false,
        draftEmpty: true,
        canRevert: true,
      }),
    ).toEqual({ type: "send" });
  });

  it("Shift+Enter is not a submit", () => {
    expect(
      deriveComposerKeyAction({
        key: "Enter",
        shiftKey: true,
        draftEmpty: false,
        canRevert: false,
      }),
    ).toEqual({ type: "none" });
  });

  it("Escape reverts only when the draft is empty and revert is available", () => {
    expect(
      deriveComposerKeyAction({
        key: "Escape",
        shiftKey: false,
        draftEmpty: true,
        canRevert: true,
      }),
    ).toEqual({ type: "revert" });
    expect(
      deriveComposerKeyAction({
        key: "Escape",
        shiftKey: false,
        draftEmpty: false,
        canRevert: true,
      }),
    ).toEqual({ type: "escape" });
    expect(
      deriveComposerKeyAction({
        key: "Escape",
        shiftKey: false,
        draftEmpty: true,
        canRevert: false,
      }),
    ).toEqual({ type: "escape" });
  });

  it('"/" reverts only on an empty, revertible composer ("//" path)', () => {
    expect(
      deriveComposerKeyAction({
        key: "/",
        shiftKey: false,
        draftEmpty: true,
        canRevert: true,
      }),
    ).toEqual({ type: "revert" });
    expect(
      deriveComposerKeyAction({
        key: "/",
        shiftKey: false,
        draftEmpty: false,
        canRevert: true,
      }),
    ).toEqual({ type: "none" });
    expect(
      deriveComposerKeyAction({
        key: "/",
        shiftKey: false,
        draftEmpty: true,
        canRevert: false,
      }),
    ).toEqual({ type: "none" });
  });

  it("other keys are no-ops", () => {
    expect(
      deriveComposerKeyAction({
        key: "a",
        shiftKey: false,
        draftEmpty: true,
        canRevert: true,
      }),
    ).toEqual({ type: "none" });
  });

  it("backtick and arrow keys are never intercepted (MET-90)", () => {
    for (const key of ["`", "~", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      for (const shiftKey of [false, true]) {
        for (const draftEmpty of [false, true]) {
          for (const canRevert of [false, true]) {
            expect(
              deriveComposerKeyAction({ key, shiftKey, draftEmpty, canRevert }),
            ).toEqual({ type: "none" });
          }
        }
      }
    }
  });

  it("Backspace dismisses only on an empty, revertible (summoned) composer", () => {
    expect(
      deriveComposerKeyAction({
        key: "Backspace",
        shiftKey: false,
        draftEmpty: true,
        canRevert: true,
      }),
    ).toEqual({ type: "backspaceDismiss" });
    // Non-empty draft: default behavior (deletes a character).
    expect(
      deriveComposerKeyAction({
        key: "Backspace",
        shiftKey: false,
        draftEmpty: false,
        canRevert: true,
      }),
    ).toEqual({ type: "none" });
    // Keeper widgets (summoned=false) never dismiss via Backspace.
    expect(
      deriveComposerKeyAction({
        key: "Backspace",
        shiftKey: false,
        draftEmpty: true,
        canRevert: false,
      }),
    ).toEqual({ type: "none" });
  });
});

describe("deriveQueuePosition", () => {
  it("counts queued turns ahead of mine on the same task", () => {
    const turns = [
      turn({ turnId: "trn_1", status: "running" }),
      turn({ turnId: "trn_2", status: "queued" }),
      turn({ turnId: "trn_3", status: "queued" }),
      turn({ turnId: "trn_4", status: "queued" }),
    ];
    expect(deriveQueuePosition(turns, "trn_4")).toBe(2);
    expect(deriveQueuePosition(turns, "trn_2")).toBe(0);
  });
});
