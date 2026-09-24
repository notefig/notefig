import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

// Real file collections over a mocked fs seam; everything the tabs entity
// reaches besides files is stubbed (same set as tabs.test.ts).
const adapter = vi.hoisted(() => ({
  readDirectory: vi.fn(),
  getMetadata: vi.fn(),
  readFiles: vi.fn(),
  writeFiles: vi.fn(),
  createFiles: vi.fn(),
  deleteFiles: vi.fn(),
}));
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    fs: adapter,
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));
vi.mock("@/utils/file-write-effects", () => ({
  invalidateDerivedState: vi.fn(),
}));
vi.mock("@/utils/markdown-conversion", () => ({
  flushDocumentSync: vi.fn(),
  whenDocumentSyncClean: vi.fn(async () => {}),
}));
vi.mock("@/tabs/tab-controllers", () => ({
  disposeTab: vi.fn(),
  focusTab: vi.fn(),
  getTabController: vi.fn(),
  getTabSelectedText: vi.fn(),
  isTabFocusable: vi.fn(),
  revealTabMatch: vi.fn(),
  searchTab: vi.fn(),
}));
vi.mock("./editors", () => ({ editor: vi.fn() }));
vi.mock("@/components/editor/editor-store", () => ({
  getMarkdownEditor: vi.fn(),
}));
vi.mock("@/utils/workspace-write-tracker", () => ({
  whenWorkspaceWritesSettled: vi.fn(async () => {}),
}));
vi.mock("./workspaces", () => ({
  useOpenWorkspacesReady: () => true,
  useOpenWorkspaces: () => openRows,
  workspaceOfPath: (path: string) =>
    openRows.find((row) => path.startsWith(`${row.path}/`))?.path ?? null,
}));
vi.mock("./agents", () => ({
  agents: { task: vi.fn() },
  agentTasksCollection: { get: vi.fn() },
  useAgentTasksReady: vi.fn(() => true),
  useAgentTaskRowsById: vi.fn(() => []),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The open set, as the workspaces entity would publish it.
const openRows: { key: string; path: string }[] = [];

import {
  workspaceCollections,
  getOrCreateWorkspaceCollections,
} from "./files";
import { useWorkspaceTabs, type WorkspaceTabsState } from "./tabs";

let testCounter = 0;
let WS_A = "";
let WS_B = "";
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe({
  openTabs,
  onState,
}: {
  openTabs: string[];
  onState: (state: WorkspaceTabsState) => void;
}) {
  const state = useWorkspaceTabs(openTabs);
  useEffect(() => {
    onState(state);
  });
  return null;
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  const n = testCounter++;
  WS_A = `/ws-join-a-${n}`;
  WS_B = `/ws-join-b-${n}`;
  adapter.readDirectory.mockImplementation(async (dir: string) => ({
    ok: true,
    value: [{ path: `${dir}/note.md`, type: "file" }],
  }));
  adapter.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter.readFiles.mockImplementation(async (paths: string[]) => ({
    succeeded: paths.map((path) => ({ path, content: "" })),
    failed: [],
  }));
  openRows.length = 0;
  for (const ws of [WS_A, WS_B]) {
    openRows.push({ key: ws, path: ws });
    await getOrCreateWorkspaceCollections(ws).metadata.preload();
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  workspaceCollections.drop(WS_A);
  workspaceCollections.drop(WS_B);
});

describe("useWorkspaceTabs across open workspaces", () => {
  it("a tab from a backgrounded workspace is not stale", async () => {
    let latest: WorkspaceTabsState | undefined;
    const tabs = [`${WS_A}/note.md`, `${WS_B}/note.md`];
    await act(async () => {
      root!.render(
        createElement(Probe, {
          openTabs: tabs,
          onState: (state) => {
            latest = state;
          },
        }),
      );
    });
    for (let i = 0; i < 20 && latest?.staleTabIds.length !== 0; i++) {
      await tick();
    }

    // Both files exist in their own workspaces, so neither tab is stale —
    // the dock is one layout over every open workspace.
    expect(latest?.staleTabIds).toEqual([]);
    expect([...(latest?.fileTabsByWorkspace ?? [])]).toEqual([
      [WS_A, [`${WS_A}/note.md`]],
      [WS_B, [`${WS_B}/note.md`]],
    ]);
  });

  it("a tab whose file is in no open workspace is stale", async () => {
    let latest: WorkspaceTabsState | undefined;
    await act(async () => {
      root!.render(
        createElement(Probe, {
          openTabs: [`${WS_A}/note.md`, `${WS_A}/gone.md`, "/nowhere/x.md"],
          onState: (state) => {
            latest = state;
          },
        }),
      );
    });
    for (let i = 0; i < 20 && latest?.staleTabIds.length !== 2; i++) {
      await tick();
    }

    // A missing file, and a file in no open workspace, are both stale.
    expect(latest?.staleTabIds).toEqual([`${WS_A}/gone.md`, "/nowhere/x.md"]);
  });
});
