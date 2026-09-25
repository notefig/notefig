import { describe, expect, it, vi } from "vitest";
import type { AgentTaskMeta } from "@/entities/agents";
import type { PromptRound } from "@/entities/prompt-rounds";
import type { RecentDocument } from "@/entities/recent-documents";
import { deriveAppStatus, type AppStatusInputs } from "./use-app-status";

vi.mock("@/adapters", async () => ({
  platformAdapter: { db: (await import("@/testing/node-db")).createNodeTestDb() },
}));
vi.mock("@/entities/workspaces", () => ({ useOpenWorkspaces: () => [] }));
vi.mock("@/utils/intl", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/components/agent/jump-to-task", () => ({ jumpToRound: vi.fn() }));
vi.mock("@/entities/scratchpads", () => ({ createAndOpenScratchpad: vi.fn() }));

const tabs = { openFile: vi.fn(() => true), openAgentTab: vi.fn() };

function round(turnId: string, overrides: Partial<PromptRound> = {}): PromptRound {
  return {
    turnId,
    taskId: "task_a",
    workspacePath: "/ws-a",
    documentPath: "/ws-a/notes.md",
    prompt: `prompt ${turnId}`,
    status: "completed",
    startedAt: 1,
    ...overrides,
  };
}

function session(taskId: string, status: AgentTaskMeta["task"]["status"] = "idle"): AgentTaskMeta {
  return {
    task: {
      taskId,
      workspacePath: "/ws-a",
      title: `session ${taskId}`,
      status,
      harnessId: "claude-code",
      createdAt: 1,
      updatedAt: 2,
    },
    queuedCount: 0,
    isRunning: status === "running",
    needsAuth: false,
    isError: false,
    isUnavailable: false,
  };
}

function document(path: string): RecentDocument {
  return { path, workspacePath: "/ws-a", lastOpenedAt: 1, isScratchpad: false };
}

function inputs(overrides: Partial<AppStatusInputs> = {}): AppStatusInputs {
  return {
    host: {
      workspacePath: "/ws-a",
      tabs,
      openWorkspace: vi.fn(),
      openSettings: vi.fn(),
    },
    rounds: [],
    sessions: [],
    documents: [],
    attention: { byRound: new Map(), byTask: new Map() },
    t: (key) => key,
    ...overrides,
  };
}

describe("deriveAppStatus", () => {
  it("lists only the sections that have rows, in the sidebar's order", () => {
    const status = deriveAppStatus(
      inputs({ rounds: [round("t1")], sessions: [session("task_a")] }),
    );
    expect(status.sections.map((section) => section.id)).toEqual(["prompts", "sessions"]);
    expect(status.attention).toBeNull();
  });

  it("marks rows as the sidebar does: attention outranks status", () => {
    const status = deriveAppStatus(
      inputs({
        rounds: [round("t1", { status: "running" }), round("t2", { status: "error" })],
        sessions: [session("task_a", "running"), session("task_b")],
        documents: [document("/ws-a/notes.md")],
        attention: {
          byRound: new Map([["t2", "error"]]),
          byTask: new Map([["task_b", "bau"]]),
        },
      }),
    );
    const [prompts, documents, sessions] = status.sections;
    expect(prompts.entries.map((e) => e.mark)).toEqual(["running", "attention-error"]);
    expect(prompts.entries.map((e) => e.detail)).toEqual(["agentRunning", "agentFailed"]);
    // A document with a round in flight shows it, like its sidebar row.
    expect(documents.entries[0]).toMatchObject({ label: "notes.md", mark: "running" });
    expect(sessions.entries.map((e) => e.mark)).toEqual(["running", "attention-bau"]);
    expect(sessions.entries.map((e) => e.detail)).toEqual(["agentRunning", "ws-a"]);
    expect(status.attention).toBe("attention-error");
  });

  it("marks the dot only from a listed row, so the menu can always show what it points at", () => {
    const status = deriveAppStatus(
      inputs({
        sessions: [session("task_a")],
        attention: { byRound: new Map(), byTask: new Map([["task_unlisted", "error"]]) },
      }),
    );
    expect(status.attention).toBeNull();
  });

  it("reads a document's running mark off every live round, not only the listed ones", () => {
    const live = ["t1", "t2", "t3", "t4"].map((id) =>
      round(id, { status: "running", documentPath: `/ws-a/${id}.md` }),
    );
    const status = deriveAppStatus(
      inputs({ rounds: live, documents: [document("/ws-a/t4.md")] }),
    );
    expect(status.sections[0].entries).toHaveLength(3);
    expect(status.sections[1].entries[0].mark).toBe("running");
  });

  it("names the document for a completed prompt instead of a time that would go stale", () => {
    const status = deriveAppStatus(inputs({ rounds: [round("t1")] }));
    expect(status.sections[0].entries[0].detail).toBe("notes.md");
  });

  it("opens entries where the sidebar would", () => {
    const status = deriveAppStatus(
      inputs({ sessions: [session("task_a")], documents: [document("/ws-a/a.md")] }),
    );
    status.sections[0].entries[0].activate();
    expect(tabs.openFile).toHaveBeenCalledWith({ tabId: "/ws-a/a.md", intent: "replace" });
    status.sections[1].entries[0].activate();
    expect(tabs.openAgentTab).toHaveBeenCalledWith("task_a");
  });

  it("keeps labels short and ids unique across sections", () => {
    const long = "x".repeat(80);
    const status = deriveAppStatus(
      inputs({ rounds: [round("t1", { prompt: long })], sessions: [session("t1")] }),
    );
    expect(status.sections[0].entries[0].label).toHaveLength(48);
    const ids = [...status.sections.flatMap((s) => s.entries), ...status.actions].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers a scratchpad only with a workspace to put it in, and no rows without tabs", () => {
    const focused = deriveAppStatus(inputs({ rounds: [round("t1")] }));
    expect(focused.actions.map((a) => a.id)).toEqual(["open-workspace", "new-scratchpad", "settings"]);

    const welcome = deriveAppStatus(
      inputs({
        host: { workspacePath: null, tabs: null, openWorkspace: vi.fn(), openSettings: vi.fn() },
        rounds: [round("t1")],
      }),
    );
    expect(welcome.sections).toEqual([]);
    expect(welcome.actions.map((a) => a.id)).toEqual(["open-workspace", "settings"]);
  });
});
